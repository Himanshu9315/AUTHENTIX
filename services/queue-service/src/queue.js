import { signAdmission } from "@authentix/internal";

// The virtual waiting room. All state lives in Redis (it is temporary by nature; nothing here needs Postgres).
// Per event E (hash tag {E} keeps one event's keys together):
//   q:{E}:wait     sorted set  userId -> join sequence number   (strict first-come-first-served, not clock time)
//   q:{E}:seen     sorted set  userId -> last time the user checked in (a user who goes quiet loses their place)
//   q:{E}:admitted sorted set  userId -> when their admission expires
//   q:{E}:seq      counter     the join sequence
//   q:events       set         events that currently have a line or admitted users (what the worker visits)
// Every operation is one Lua script, so it is atomic even with several instances.

const JOIN = `
local exp = redis.call('ZSCORE', KEYS[3], ARGV[1])
if exp and tonumber(exp) > tonumber(ARGV[2]) then return {'admitted', exp} end
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local s = redis.call('INCR', KEYS[4])
  redis.call('ZADD', KEYS[1], s, ARGV[1])
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('SADD', KEYS[5], ARGV[3])
return {'waiting', redis.call('ZRANK', KEYS[1], ARGV[1]), redis.call('ZCARD', KEYS[1])}`;

const STATUS = `
local exp = redis.call('ZSCORE', KEYS[3], ARGV[1])
if exp and tonumber(exp) > tonumber(ARGV[2]) then return {'admitted', exp} end
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if not rank then return {'none'} end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return {'waiting', rank, redis.call('ZCARD', KEYS[1])}`;

const LEAVE = `
redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('ZREM', KEYS[3], ARGV[1])
return 1`;

// One worker pass for one event: forget expired admissions, drop people who went quiet, then let the next batch in.
const TICK = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local idle = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]))
for _, u in ipairs(idle) do redis.call('ZREM', KEYS[1], u); redis.call('ZREM', KEYS[2], u) end
local batch = tonumber(ARGV[2])
local nxt = {}
-- A batch of 0 must admit nobody ("ZRANGE 0 -1" would mean the whole line).
if batch > 0 then nxt = redis.call('ZRANGE', KEYS[1], 0, batch - 1) end
for _, u in ipairs(nxt) do
  redis.call('ZREM', KEYS[1], u); redis.call('ZREM', KEYS[2], u)
  redis.call('ZADD', KEYS[3], now + tonumber(ARGV[3]), u)
end
if redis.call('ZCARD', KEYS[1]) == 0 and redis.call('ZCARD', KEYS[3]) == 0 then redis.call('SREM', KEYS[4], ARGV[5]) end
return #nxt`;

const k = (e) => ({ wait: `q:{${e}}:wait`, seen: `q:{${e}}:seen`, admitted: `q:{${e}}:admitted`, seq: `q:{${e}}:seq` });
const EVENTS = "q:events";

/**
 * @param {{ redis: import("ioredis").Redis, config: { admissionSecret: string, batchSize: number, intervalSeconds: number, admissionTtlSeconds: number, idleSeconds: number } }} deps
 */
export function createQueue({ redis, config }) {
  const { batchSize, intervalSeconds } = config;

  // One clock for every instance: Redis's own. Instance clocks can differ, and idle limits, admission expiry and the
  // admitted check must all agree. (Tests pass an explicit time.)
  const clock = async () => {
    const [sec, micro] = await redis.time();
    return Number(sec) * 1000 + Math.floor(Number(micro) / 1000);
  };

  // Position 1 is next. Everyone ahead plus you is admitted batchSize at a time every intervalSeconds, so this is the
  // longest you should wait (people ahead who give up only make it shorter).
  const eta = (rank) => Math.ceil((rank + 1) / batchSize) * intervalSeconds;

  const admitted = (userId, eventId, expiresAtMs) => ({
    state: "admitted",
    expiresAt: new Date(expiresAtMs).toISOString(),
    admissionToken: signAdmission(config.admissionSecret, { userId, eventId, expiresAtMs }),
  });
  const waiting = (rank, total) => ({ state: "waiting", position: rank + 1, ahead: rank, total, etaSeconds: eta(rank) });

  return {
    async join(userId, eventId, now) {
      now ??= await clock();
      const q = k(eventId);
      const r = await redis.eval(JOIN, 5, q.wait, q.seen, q.admitted, q.seq, EVENTS, userId, now, eventId);
      return r[0] === "admitted" ? admitted(userId, eventId, Number(r[1])) : waiting(Number(r[1]), Number(r[2]));
    },
    /** Checking in also counts as "still here", which keeps your place. */
    async status(userId, eventId, now) {
      now ??= await clock();
      const q = k(eventId);
      const r = await redis.eval(STATUS, 3, q.wait, q.seen, q.admitted, userId, now);
      if (r[0] === "admitted") return admitted(userId, eventId, Number(r[1]));
      return r[0] === "waiting" ? waiting(Number(r[1]), Number(r[2])) : { state: "none" };
    },
    async leave(userId, eventId) {
      const q = k(eventId);
      await redis.eval(LEAVE, 3, q.wait, q.seen, q.admitted, userId);
    },
    /** One admission pass over every event that has a line. Returns how many people were let in. */
    async tick(now) {
      now ??= await clock();
      let total = 0;
      for (const eventId of await redis.smembers(EVENTS)) {
        const q = k(eventId);
        total += Number(await redis.eval(TICK, 4, q.wait, q.seen, q.admitted, EVENTS, now, batchSize, config.admissionTtlSeconds * 1000, config.idleSeconds * 1000, eventId));
      }
      return total;
    },
    /** Only one instance runs each pass, so several instances don't multiply the admission rate. */
    async tickIfLeader(now) {
      const ttl = Math.max(1000, intervalSeconds * 1000 - 500);
      return (await redis.set("q:leader", "1", "PX", ttl, "NX")) ? this.tick(now) : 0;
    },
  };
}
