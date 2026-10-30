import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Redis } from "ioredis";
import { seatKey } from "../src/holds.js";

const adminUrl = process.env.TEST_PG_URL;
const redisUrl = process.env.TEST_REDIS_URL; // must point at a scratch logical DB, e.g. redis://127.0.0.1:6379/15
const skip = adminUrl && redisUrl ? false : "TEST_PG_URL / TEST_REDIS_URL not set (needs the dev Postgres and Redis from docker compose)";

const BUYERS = 50;

describe("seat and stock races", { skip }, () => {
  const dbName = `inventory_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin, pool, redis, store;
  const eventId = randomUUID();
  const seatedTier = randomUUID();
  const gaTier = randomUUID();
  const seatIds = [];

  before(async () => {
    // Tests flush Redis, so refuse to run against the dev data in logical DB 0.
    assert.match(redisUrl, /\/([1-9]|1[0-5])$/, "TEST_REDIS_URL must name a scratch logical DB (1-15), never DB 0");
    const { createPool } = await import("../src/db.js");
    const { createHoldStore } = await import("../src/holds.js");
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = await createPool(url.toString());
    redis = new Redis(redisUrl);
    store = createHoldStore({ pool, redis });

    await pool.query("INSERT INTO event_inventory (event_id) VALUES ($1)", [eventId]);
    await pool.query("INSERT INTO tier_stock (tier_id, event_id, kind, capacity) VALUES ($1,$2,'seated',5), ($3,$2,'ga',10)", [seatedTier, eventId, gaTier]);
    for (let n = 1; n <= 5; n++) {
      const { rows } = await pool.query("INSERT INTO seats (event_id, tier_id, section, row_label, number, x, y) VALUES ($1,$2,'S','A',$3,0,0) RETURNING id", [eventId, seatedTier, n]);
      seatIds.push(rows[0].id);
    }
  });

  after(async () => {
    await redis?.flushdb();
    await redis?.quit();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const seatItem = (i) => [{ tierId: seatedTier, seatId: seatIds[i] }];
  const buyers = () => Array.from({ length: BUYERS }, () => randomUUID());

  test("50 buyers holding the same seat: exactly one wins", async () => {
    await redis.flushdb();
    const results = await Promise.all(buyers().map((orderId) => store.hold({ orderId, eventId, items: seatItem(0), ttlSeconds: 60 })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.error === "seats_unavailable").length, BUYERS - 1);
  });

  test("a multi-seat hold is all-or-nothing", async () => {
    await redis.flushdb();
    const first = randomUUID();
    assert.ok((await store.hold({ orderId: first, eventId, items: seatItem(1), ttlSeconds: 60 })).ok);
    const second = await store.hold({ orderId: randomUUID(), eventId, items: [...seatItem(2), ...seatItem(1)], ttlSeconds: 60 });
    assert.equal(second.ok, false);
    // seat 2 must not stay held by the failed order
    assert.ok((await store.hold({ orderId: randomUUID(), eventId, items: seatItem(2), ttlSeconds: 60 })).ok);
  });

  test("Redis lost, 50 buyers confirm the same seat without the Redis fence: Postgres lets exactly one sell", async () => {
    await redis.flushdb(); // simulates Redis restart: every hold is gone
    const results = await Promise.all(buyers().map((orderId) => store.confirm({ orderId, eventId, items: seatItem(3), fence: false })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM seat_sales WHERE seat_id = $1", [seatIds[3]]);
    assert.equal(rows[0].n, 1);
  });

  test("50 buyers confirm the same seat with the fence: still exactly one sale", async () => {
    await redis.flushdb();
    const results = await Promise.all(buyers().map((orderId) => store.confirm({ orderId, eventId, items: seatItem(4) })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM seat_sales WHERE seat_id = $1", [seatIds[4]]);
    assert.equal(rows[0].n, 1);
  });

  test("confirm is idempotent for the same order, and a sold seat can no longer be held", async () => {
    const { rows } = await pool.query("SELECT order_id FROM seat_sales WHERE seat_id = $1", [seatIds[4]]);
    assert.ok((await store.confirm({ orderId: rows[0].order_id, eventId, items: seatItem(4) })).ok);
    const late = await store.hold({ orderId: randomUUID(), eventId, items: seatItem(4), ttlSeconds: 60 });
    assert.equal(late.ok, false);
    // A competing hold can briefly set its own Redis key on a sold seat before Postgres rejects it.
    // A retried confirm by the real owner must still succeed rather than look like a failure (and trigger a refund).
    await redis.set(seatKey(eventId, seatIds[4]), randomUUID(), "PX", 5000);
    assert.ok((await store.confirm({ orderId: rows[0].order_id, eventId, items: seatItem(4) })).ok);
  });

  test("a failed confirm releases the fence it took, so the seat isn't blocked for a minute", async () => {
    await redis.flushdb();
    const loser = randomUUID();
    // seat 3 is already sold (earlier test), so this confirm fails after fencing seat 2
    const r = await store.confirm({ orderId: loser, eventId, items: [...seatItem(2), ...seatItem(3)] });
    assert.equal(r.ok, false);
    assert.ok((await store.hold({ orderId: randomUUID(), eventId, items: seatItem(2), ttlSeconds: 60 })).ok);
  });

  test("GA tier of 10 with 50 buyers: exactly 10 holds", async () => {
    await redis.flushdb();
    const gaItem = [{ tierId: gaTier, quantity: 1 }];
    const results = await Promise.all(buyers().map((orderId) => store.hold({ orderId, eventId, items: gaItem, ttlSeconds: 60 })));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.equal(results.filter((r) => !r.ok && r.error === "sold_out").length, BUYERS - 10);
  });

  test("GA: 50 parallel confirms with no holds at all sell exactly 10", async () => {
    await redis.flushdb();
    const gaItem = [{ tierId: gaTier, quantity: 1 }];
    const results = await Promise.all(buyers().map((orderId) => store.confirm({ orderId, eventId, items: gaItem })));
    assert.equal(results.filter((r) => r.ok).length, 10);
    const { rows } = await pool.query("SELECT sold FROM tier_stock WHERE tier_id = $1", [gaTier]);
    assert.equal(rows[0].sold, 10);
  });
});
