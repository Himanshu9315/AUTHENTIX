// Seat and ticket holds. Redis holds are temporary reservations (TTL); Postgres is the only thing that
// guarantees a sale. If Redis loses data, the worst case is a buyer is refunded, never a double sale.

const SEAT_HOLD = `
for i, k in ipairs(KEYS) do local v = redis.call('GET', k)
  if v and v ~= ARGV[1] then return i end end
for _, k in ipairs(KEYS) do redis.call('SET', k, ARGV[1], 'PX', ARGV[2]) end
return 0`;

const SEAT_RELEASE = `
for _, k in ipairs(KEYS) do if redis.call('GET', k) == ARGV[1] then redis.call('DEL', k) end end
return 0`;

// Short-lived claim taken just before the Postgres sale, so a live hold by someone else wins.
const SEAT_FENCE = `
for i, k in ipairs(KEYS) do local v = redis.call('GET', k)
  if v and v ~= ARGV[1] then return i end end
for _, k in ipairs(KEYS) do redis.call('SET', k, ARGV[1], 'PX', ARGV[2]) end
return 0`;

const GA_HOLD = `
local gone = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
for _, id in ipairs(gone) do local q = redis.call('HGET', KEYS[3], id)
  if q then redis.call('DECRBY', KEYS[1], q) end
  redis.call('ZREM', KEYS[2], id); redis.call('HDEL', KEYS[3], id) end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1]); return 0 end
local held = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[4]) + held + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return -1 end
redis.call('INCRBY', KEYS[1], ARGV[2]); redis.call('HSET', KEYS[3], ARGV[1], ARGV[2]); redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1])
return 0`;

const GA_RELEASE = `
local q = redis.call('HGET', KEYS[3], ARGV[1])
if q then redis.call('DECRBY', KEYS[1], q); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('HDEL', KEYS[3], ARGV[1]) end
return 0`;

const FENCE_MS = 60_000;

export const seatKey = (eventId, seatId) => `inv:{${eventId}}:seat:${seatId}`;
const gaKeys = (eventId, tierId) => [`inv:{${eventId}}:ga:${tierId}:held`, `inv:{${eventId}}:ga:${tierId}:exp`, `inv:{${eventId}}:ga:${tierId}:qty`];

/** A request problem (bad seat or tier), as opposed to a conflict. */
export class InvalidItems extends Error {}

/**
 * @param {{ pool: import("pg").Pool, redis: import("ioredis").Redis }} deps
 */
export function createHoldStore({ pool, redis }) {
  /** Validates items against Postgres and groups them into seats and GA quantities. */
  async function plan(eventId, items) {
    const seatIds = items.filter((i) => i.seatId).map((i) => i.seatId);
    if (new Set(seatIds).size !== seatIds.length) throw new InvalidItems("duplicate seat");
    const seats = [];
    if (seatIds.length) {
      const { rows } = await pool.query("SELECT id, tier_id FROM seats WHERE event_id = $1 AND id = ANY($2::uuid[])", [eventId, seatIds]);
      const tierOf = new Map(rows.map((r) => [r.id, r.tier_id]));
      for (const i of items.filter((x) => x.seatId)) {
        if (tierOf.get(i.seatId) !== i.tierId) throw new InvalidItems("unknown seat");
        seats.push({ seatId: i.seatId, key: seatKey(eventId, i.seatId) });
      }
    }
    const qtyByTier = new Map();
    for (const i of items.filter((x) => !x.seatId)) qtyByTier.set(i.tierId, (qtyByTier.get(i.tierId) ?? 0) + i.quantity);
    const ga = [];
    if (qtyByTier.size) {
      const { rows } = await pool.query("SELECT tier_id, capacity FROM tier_stock WHERE event_id = $1 AND kind = 'ga' AND tier_id = ANY($2::uuid[])", [eventId, [...qtyByTier.keys()]]);
      if (rows.length !== qtyByTier.size) throw new InvalidItems("unknown tier");
      for (const r of rows) ga.push({ tierId: r.tier_id, qty: qtyByTier.get(r.tier_id), capacity: r.capacity, keys: gaKeys(eventId, r.tier_id) });
    }
    return { seats, ga };
  }

  async function releasePlanned(orderId, p) {
    if (p.seats.length) await redis.eval(SEAT_RELEASE, p.seats.length, ...p.seats.map((s) => s.key), orderId);
    for (const g of p.ga) await redis.eval(GA_RELEASE, 3, ...g.keys, orderId);
  }

  return {
    /** Takes (or refreshes) a hold. Idempotent for the same orderId, so it doubles as "extend". */
    async hold({ orderId, eventId, items, ttlSeconds }) {
      const p = await plan(eventId, items);
      const ttlMs = ttlSeconds * 1000;
      const now = Date.now();
      if (p.seats.length) {
        const taken = await redis.eval(SEAT_HOLD, p.seats.length, ...p.seats.map((s) => s.key), orderId, ttlMs);
        if (taken !== 0) {
          await releasePlanned(orderId, p);
          return { ok: false, error: "seats_unavailable", seatIds: [p.seats[taken - 1].seatId] };
        }
        // Acquire first, then check Postgres: a seat sold in between is still caught, because confirm
        // only deletes its Redis keys after its commit.
        const { rows } = await pool.query("SELECT seat_id FROM seat_sales WHERE seat_id = ANY($1::uuid[])", [p.seats.map((s) => s.seatId)]);
        if (rows.length) {
          await releasePlanned(orderId, p);
          return { ok: false, error: "seats_unavailable", seatIds: rows.map((r) => r.seat_id) };
        }
      }
      for (const g of p.ga) {
        const { rows } = await pool.query("SELECT sold FROM tier_stock WHERE tier_id = $1", [g.tierId]);
        const r = await redis.eval(GA_HOLD, 3, ...g.keys, orderId, g.qty, g.capacity, rows[0].sold, now, now + ttlMs);
        if (r === -1) {
          await releasePlanned(orderId, p);
          return { ok: false, error: "sold_out", tierId: g.tierId };
        }
      }
      return { ok: true, expiresAt: new Date(now + ttlMs).toISOString() };
    },

    async release({ orderId, eventId, items }) {
      await releasePlanned(orderId, await plan(eventId, items));
      return { ok: true };
    },

    /**
     * Turns a hold into a sale. Idempotent per order. `fence: false` skips the Redis claim so tests can
     * prove Postgres alone prevents double sales.
     */
    async confirm({ orderId, eventId, items, fence = true }) {
      const p = await plan(eventId, items);
      const fail = async (body) => {
        await releasePlanned(orderId, p);
        return { ok: false, ...body };
      };
      if (fence && p.seats.length) {
        // Seats already sold to this order need no claim (a retried confirm must stay idempotent even if a
        // competing hold briefly set its own Redis key on a sold seat).
        const ids = p.seats.map((x) => x.seatId);
        const { rows } = await pool.query("SELECT seat_id FROM seat_sales WHERE seat_id = ANY($1::uuid[]) AND order_id = $2", [ids, orderId]);
        const mine = new Set(rows.map((r) => r.seat_id));
        const toFence = p.seats.filter((x) => !mine.has(x.seatId));
        if (toFence.length) {
          const taken = await redis.eval(SEAT_FENCE, toFence.length, ...toFence.map((x) => x.key), orderId, FENCE_MS);
          if (taken !== 0) return fail({ error: "seats_unavailable", seatIds: [toFence[taken - 1].seatId] });
        }
      }
      // Never touch `pool` while holding `client`: with many parallel confirms that would exhaust the pool.
      let failure = null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (p.seats.length) {
          const ids = p.seats.map((s) => s.seatId);
          const ins = await client.query(
            "INSERT INTO seat_sales (seat_id, order_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT (seat_id) DO NOTHING RETURNING seat_id",
            [ids, orderId],
          );
          const mine = await client.query("SELECT count(*)::int AS n FROM seat_sales WHERE seat_id = ANY($1::uuid[]) AND order_id = $2", [ids, orderId]);
          if (mine.rows[0].n !== ids.length) {
            const sold = await client.query("SELECT seat_id FROM seat_sales WHERE seat_id = ANY($1::uuid[]) AND order_id <> $2", [ids, orderId]);
            failure = { error: "seats_unavailable", seatIds: sold.rows.map((r) => r.seat_id) };
          } else if (ins.rowCount > 0) {
            await client.query(
              `UPDATE tier_stock t SET sold = t.sold + c.n
               FROM (SELECT tier_id, count(*)::int AS n FROM seats WHERE id = ANY($1::uuid[]) GROUP BY tier_id) c
               WHERE t.tier_id = c.tier_id`,
              [ins.rows.map((r) => r.seat_id)],
            );
          }
        }
        for (const g of failure ? [] : p.ga) {
          const ins = await client.query("INSERT INTO ga_sales (order_id, tier_id, qty) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1", [orderId, g.tierId, g.qty]);
          if (ins.rowCount === 0) continue; // already confirmed for this order
          const upd = await client.query("UPDATE tier_stock SET sold = sold + $1 WHERE tier_id = $2 AND sold + $1 <= capacity", [g.qty, g.tierId]);
          if (upd.rowCount !== 1) {
            failure = { error: "sold_out", tierId: g.tierId };
            break;
          }
        }
        await client.query(failure ? "ROLLBACK" : "COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        await releasePlanned(orderId, p).catch(() => {}); // don't leave the 60 s fence behind
        throw err;
      } finally {
        client.release();
      }
      if (failure) return fail(failure);
      await releasePlanned(orderId, p); // only after the commit
      return { ok: true };
    },

    plan,
  };
}
