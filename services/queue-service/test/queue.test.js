import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { verifyAdmission } from "@authentix/internal";

const redisUrl = process.env.TEST_REDIS_URL; // must be a scratch logical DB (1-15): these tests flush it
const skip = redisUrl ? false : "TEST_REDIS_URL not set (needs the dev Redis from docker compose)";
const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, level: "silent" };
const SECRET = "q".repeat(40);

describe("waiting room", { skip }, () => {
  let redis, queue, app;
  const cfg = { admissionSecret: SECRET, batchSize: 3, intervalSeconds: 5, admissionTtlSeconds: 600, idleSeconds: 90 };
  const fx = { hot: true, emailVerified: true, aadhaar: true, down: false };
  const clients = {
    getEvent: async () => { if (fx.down) throw new Error("down"); return { status: 200, json: { status: "published", hotSale: fx.hot } }; },
    getUser: async () => ({ status: 200, json: { emailVerified: fx.emailVerified } }),
    getHolder: async () => ({ status: 200, json: { verified: fx.aadhaar } }),
  };

  before(async () => {
    assert.match(redisUrl, /\/([1-9]|1[0-5])$/, "TEST_REDIS_URL must name a scratch logical DB (1-15), never DB 0");
    const { createQueue } = await import("../src/queue.js");
    const { buildApp } = await import("../src/app.js");
    redis = new Redis(redisUrl);
    await redis.flushdb();
    queue = createQueue({ redis, config: cfg });
    app = await buildApp({ redis, queue, clients, logger: silent, config: cfg });
  });
  after(async () => {
    await app?.close();
    await redis?.flushdb();
    await redis?.quit();
  });

  const ev = () => randomUUID();
  const users = (n) => Array.from({ length: n }, () => randomUUID());
  const T = 1_800_000_000_000;

  test("people are served strictly in the order they joined, and joining twice keeps your place", async () => {
    const e = ev();
    const [a, b, c] = users(3);
    assert.equal((await queue.join(a, e, T)).position, 1);
    assert.equal((await queue.join(b, e, T)).position, 2);
    assert.equal((await queue.join(c, e, T)).position, 3);
    assert.equal((await queue.join(a, e, T + 5)).position, 1); // again: still first
    assert.deepEqual([(await queue.status(c, e, T)).position, (await queue.status(c, e, T)).ahead], [3, 2]);
  });

  test("20 people joining at the same instant each get a unique place, 1 to 20", async () => {
    const e = ev();
    const all = users(20);
    const results = await Promise.all(all.map((u) => queue.join(u, e, T)));
    assert.deepEqual(results.map((r) => r.position).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("each pass admits exactly one batch, from the front, and gives them a token that works for them only", async () => {
    const e = ev();
    const all = users(7);
    for (const u of all) await queue.join(u, e, T);
    await redis.del("q:events"); // the worker visits every event in this list, so isolate this one
    await redis.sadd("q:events", e);
    assert.equal(await queue.tick(T), 3);
    const [first, , , fourth] = [all[0], all[1], all[2], all[3]];
    const s1 = await queue.status(first, e, T);
    assert.equal(s1.state, "admitted");
    assert.equal(verifyAdmission(SECRET, s1.admissionToken, { userId: first, eventId: e, now: T }).ok, true);
    assert.equal(verifyAdmission(SECRET, s1.admissionToken, { userId: fourth, eventId: e, now: T }).reason, "wrong_user");
    assert.equal(verifyAdmission(SECRET, s1.admissionToken, { userId: first, eventId: ev(), now: T }).reason, "wrong_event");
    const s4 = await queue.status(fourth, e, T);
    assert.deepEqual([s4.state, s4.position, s4.etaSeconds], ["waiting", 1, 5]); // moved up to the front
    assert.equal(await queue.tick(T + 5000), 3);
    assert.equal(await queue.tick(T + 10_000), 1);
    assert.equal(await queue.tick(T + 15_000), 0);
  });

  test("the estimated wait is the number of batches ahead times the interval", async () => {
    const e = ev();
    const all = users(10);
    for (const u of all) await queue.join(u, e, T);
    const eta = async (i) => (await queue.status(all[i], e, T)).etaSeconds;
    assert.deepEqual([await eta(0), await eta(2), await eta(3), await eta(9)], [5, 5, 10, 20]);
  });

  test("an admitted person gets the same token again after a reload, and joining again does not put them back in line", async () => {
    const e = ev();
    const [u] = users(1);
    await queue.join(u, e, T);
    await redis.sadd("q:events", e);
    await queue.tick(T);
    const a = await queue.status(u, e, T + 1000);
    const b = await queue.join(u, e, T + 2000);
    assert.equal(a.state, "admitted");
    assert.equal(b.state, "admitted");
    assert.equal(a.admissionToken, b.admissionToken);
    assert.equal((await redis.zcard(`q:{${e}}:wait`)), 0);
  });

  test("an admission expires after its time, and the person is no longer admitted", async () => {
    const e = ev();
    const [u] = users(1);
    await queue.join(u, e, T);
    await redis.sadd("q:events", e);
    await queue.tick(T);
    assert.equal((await queue.status(u, e, T + 599_000)).state, "admitted");
    assert.equal((await queue.status(u, e, T + 601_000)).state, "none");
    await queue.tick(T + 601_000);
    assert.equal(await redis.sismember("q:events", e), 0); // an idle event drops out of the worker's list
  });

  test("someone who stops checking in loses their place; someone who keeps checking in keeps it", async () => {
    const e = ev();
    const [quiet, active, other] = users(3);
    for (const u of [quiet, active, other]) await queue.join(u, e, T);
    await queue.status(active, e, T + 80_000); // a check-in just before the cut-off
    const slow = await createQueueWith({ batchSize: 0 }); // a pass that admits nobody, only tidies
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    await slow.tick(T + 100_000); // 100 s: quiet and other are past the 90 s limit
    assert.equal((await queue.status(quiet, e, T + 100_000)).state, "none");
    assert.equal((await queue.status(other, e, T + 100_000)).state, "none");
    assert.deepEqual([(await queue.status(active, e, T + 100_000)).state, (await queue.status(active, e, T + 100_000)).position], ["waiting", 1]);
    assert.equal((await queue.join(quiet, e, T + 101_000)).position, 2); // comes back at the end
  });

  test("a batch size of 0 admits nobody (it must never mean 'the whole line')", async () => {
    const e = ev();
    for (const u of users(5)) await queue.join(u, e, T);
    const none = await createQueueWith({ batchSize: 0 });
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    assert.equal(await none.tick(T), 0);
    assert.equal(await redis.zcard(`q:{${e}}:wait`), 5);
  });

  test("leaving removes you, and the people behind move up", async () => {
    const e = ev();
    const [a, b, c] = users(3);
    for (const u of [a, b, c]) await queue.join(u, e, T);
    await queue.leave(a, e);
    assert.equal((await queue.status(a, e, T)).state, "none");
    assert.equal((await queue.status(c, e, T)).position, 2);
  });

  test("only one instance runs each pass", async () => {
    const e = ev();
    const all = users(9);
    for (const u of all) await queue.join(u, e, T);
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    await redis.del("q:leader");
    const counts = await Promise.all([queue.tickIfLeader(T), queue.tickIfLeader(T), queue.tickIfLeader(T)]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 3); // one batch, not three
  });

  function createQueueWith(over) {
    return import("../src/queue.js").then((m) => m.createQueue({ redis, config: { ...cfg, ...over } }));
  }

  test("joining needs a hot-sale event and a fully verified user, fails closed, and the status call never touches other services", async () => {
    const hdr = (u) => ({ "x-user-id": u });
    const join = (u, e) => app.inject({ method: "POST", url: `/queue/events/${e}/join`, headers: hdr(u) });
    const e = ev();
    const [u] = users(1);
    assert.equal((await join(u, e)).statusCode, 200);
    fx.emailVerified = false;
    assert.deepEqual([(await join(randomUUID(), e)).statusCode, (await join(randomUUID(), e)).json().error], [403, "email_not_verified"]);
    fx.emailVerified = true;
    fx.aadhaar = false;
    assert.equal((await join(randomUUID(), e)).json().error, "aadhaar_not_verified");
    fx.aadhaar = true;
    fx.hot = false;
    assert.equal((await join(randomUUID(), e)).json().error, "queue_not_needed");
    fx.hot = true;
    fx.down = true;
    assert.equal((await join(randomUUID(), e)).statusCode, 503);
    const calls = { n: 0 };
    const real = clients.getEvent;
    clients.getEvent = async (...a) => (calls.n++, real(...a));
    fx.down = false;
    assert.equal((await app.inject({ method: "GET", url: `/queue/events/${e}/me`, headers: hdr(u) })).json().state, "waiting");
    clients.getEvent = real;
    assert.equal(calls.n, 0);
    assert.equal((await app.inject({ method: "GET", url: `/queue/events/${e}/me` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/queue/events/not-a-uuid/me`, headers: hdr(u) })).statusCode, 404);
  });

  test("leaving over HTTP works even if the client sends a JSON content-type with no body, and an admitted person who leaves is out", async () => {
    const e = ev();
    const [u] = users(1);
    const h = { "x-user-id": u, "content-type": "application/json" };
    await app.inject({ method: "POST", url: `/queue/events/${e}/join`, headers: h });
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    await queue.tick(Date.now());
    assert.equal((await app.inject({ method: "GET", url: `/queue/events/${e}/me`, headers: h })).json().state, "admitted");
    assert.equal((await app.inject({ method: "DELETE", url: `/queue/events/${e}/me`, headers: h })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/queue/events/${e}/me`, headers: h })).json().state, "none");
  });

  test("a leader that crashes frees its lock, so the next pass can run", async () => {
    const e = ev();
    for (const u of users(2)) await queue.join(u, e, T);
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    await redis.del("q:leader");
    assert.equal(await queue.tickIfLeader(T), 2);
    await queue.join(users(1)[0], e, T);
    assert.equal(await queue.tickIfLeader(T), 0); // still locked by the "crashed" leader
    await redis.pexpire("q:leader", 30);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await queue.tickIfLeader(T), 1);
  });

  test("over HTTP, rejoining after leaving puts you at the back", async () => {
    const e = ev();
    const [a, b] = users(2);
    const call = (method, u, path) => app.inject({ method, url: `/queue/events/${e}/${path}`, headers: { "x-user-id": u } });
    await call("POST", a, "join");
    await call("POST", b, "join");
    await call("DELETE", a, "me");
    assert.equal((await call("POST", a, "join")).json().position, 2);
    assert.equal((await call("GET", b, "me")).json().position, 1);
  });

  test("the clock comes from Redis when no time is given, and an admission lasts as configured", async () => {
    const e = ev();
    const [u] = users(1);
    await queue.join(u, e);
    await redis.del("q:events");
    await redis.sadd("q:events", e);
    await queue.tick();
    const s = await queue.status(u, e);
    const left = Date.parse(s.expiresAt) - Date.now();
    assert.ok(s.state === "admitted" && left > 590_000 && left <= 600_500, String(left));
  });

  test("a person can join only so often per minute, which protects the services behind the join check", async () => {
    const [u] = users(1);
    const e = ev();
    const codes = [];
    for (let i = 0; i < 22; i++) codes.push((await app.inject({ method: "POST", url: `/queue/events/${e}/join`, headers: { "x-user-id": u } })).statusCode);
    assert.equal(codes.filter((c) => c === 200).length, 20);
    assert.equal(codes.filter((c) => c === 429).length, 2);
  });
});
