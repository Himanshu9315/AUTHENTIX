import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EVENT_ID, TIER_ID, makeDb, makeFakes, silentLogger, skip } from "./helpers.js";

describe("per-Aadhaar ticket cap", { skip }, () => {
  let db, fakes, saga;
  before(async () => {
    const { createSaga } = await import("../src/saga.js");
    db = await makeDb();
    fakes = makeFakes();
    saga = createSaga({ pool: db.pool, clients: fakes.clients, logger: silentLogger });
  });
  after(() => db?.drop());

  const order = (userId, quantity = 1) =>
    saga.createOrder({ userId, key: `key-${randomUUID()}`, body: { eventId: EVENT_ID, items: [{ tierId: TIER_ID, quantity }] }, requestId: "r" }).then(
      (r) => ({ ok: true, order: r.order }),
      (e) => ({ ok: false, status: e.status, error: e.body?.error, remaining: e.body?.remaining }),
    );

  test("10 parallel orders on one Aadhaar with a cap of 4: exactly 4 succeed", async () => {
    fakes.holderOf = () => "one-aadhaar"; // ten accounts, one Aadhaar (the accounts would be blocked earlier in real life; this isolates the cap)
    const results = await Promise.all(Array.from({ length: 10 }, () => order(randomUUID())));
    assert.equal(results.filter((r) => r.ok).length, 4);
    const rejected = results.filter((r) => !r.ok);
    assert.equal(rejected.length, 6);
    assert.ok(rejected.every((r) => r.status === 409 && r.error === "ticket_cap_exceeded" && r.remaining === 0));
    const { rows } = await db.pool.query("SELECT qty FROM cap_usage WHERE holder_key = 'one-aadhaar'");
    assert.equal(rows[0].qty, 4);
  });

  test("a cancelled order gives its tickets back, so a fifth can be bought", async () => {
    const { rows } = await db.pool.query("SELECT id, user_id FROM orders WHERE holder_key = 'one-aadhaar' AND state = 'HELD' LIMIT 1");
    await saga.cancelOrder({ userId: rows[0].user_id, orderId: rows[0].id, requestId: "r" });
    assert.equal((await db.pool.query("SELECT qty FROM cap_usage WHERE holder_key = 'one-aadhaar'")).rows[0].qty, 3);
    assert.ok((await order(randomUUID())).ok);
    assert.equal((await order(randomUUID())).ok, false);
  });

  test("one order cannot exceed the cap by asking for many tickets at once", async () => {
    fakes.holderOf = () => "big-buyer";
    const r = await order(randomUUID(), 5);
    assert.equal(r.ok, false);
    assert.equal(r.error, "ticket_cap_exceeded");
  });

  test("different Aadhaar holders do not share a cap", async () => {
    fakes.holderOf = (userId) => `holder-${userId}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => order(randomUUID(), 4)));
    assert.equal(results.filter((r) => r.ok).length, 5);
  });

  test("unverified users cannot book", async () => {
    fakes.verified = false;
    const r = await order(randomUUID());
    fakes.verified = true;
    assert.equal(r.error, "aadhaar_not_verified");
    fakes.emailVerified = false;
    const r2 = await order(randomUUID());
    fakes.emailVerified = true;
    assert.equal(r2.error, "email_not_verified");
  });
});
