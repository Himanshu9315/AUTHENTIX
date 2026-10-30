import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EVENT_ID, SEAT_ID, TIER_ID, makeDb, makeFakes, silentLogger, skip } from "./helpers.js";

describe("booking saga", { skip }, () => {
  let db, fakes, saga;
  before(async () => {
    const { createSaga } = await import("../src/saga.js");
    db = await makeDb();
    fakes = makeFakes();
    saga = createSaga({ pool: db.pool, clients: fakes.clients, logger: silentLogger });
  });
  after(() => db?.drop());

  const card = { method: "card", card: { number: "4242 4242 4242 4242", expMonth: 12, expYear: 2030, cvc: "123" } };
  const key = () => `key-${randomUUID()}`;
  const state = async (id) => (await db.pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
  const capQty = async (holder) => (await db.pool.query("SELECT qty FROM cap_usage WHERE holder_key = $1", [holder])).rows[0]?.qty;
  const outbox = async (type, orderId) => (await db.pool.query("SELECT payload FROM outbox WHERE type = $1 AND payload->>'orderId' = $2", [type, orderId])).rows;

  async function newOrder(userId = randomUUID(), items = [{ tierId: TIER_ID, quantity: 2 }]) {
    const { order } = await saga.createOrder({ userId, key: key(), body: { eventId: EVENT_ID, items }, requestId: "r" });
    return { userId, id: order.id, order };
  }
  const pay = (o, k = key()) => saga.payOrder({ userId: o.userId, orderId: o.id, key: k, body: card, requestId: "r" });
  const currentPayment = async (id) => (await state(id)).current_payment_id;

  test("happy path: hold, pay, confirm emits order.confirmed and keeps the cap used", async () => {
    const o = await newOrder();
    assert.equal(o.order.state, "HELD");
    assert.equal(o.order.totalInr, 2000);
    await pay(o);
    assert.equal((await state(o.id)).state, "PAYMENT_PENDING");
    await saga.applyPayment(o.id, await currentPayment(o.id), "succeeded");
    assert.equal((await state(o.id)).state, "CONFIRMED");
    const [evt] = await outbox("order.confirmed", o.id);
    assert.equal(evt.payload.totalInr, 2000);
    assert.equal(JSON.stringify(evt.payload).includes("holder"), false); // no cap key in events
    assert.equal(await capQty(`holder-${o.userId}`), 2);
  });

  test("payment declined: back to HELD, then FAILED after 3 attempts with the cap and hold released", async () => {
    const o = await newOrder();
    const released = fakes.calls.release;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await pay(o);
      await saga.applyPayment(o.id, await currentPayment(o.id), "failed");
      const s = await state(o.id);
      assert.equal(s.state, attempt < 3 ? "HELD" : "FAILED");
    }
    assert.equal((await state(o.id)).failure_reason, "payment_failed");
    assert.equal(await capQty(`holder-${o.userId}`), 0);
    assert.ok(fakes.calls.release > released);
  });

  test("hold expires before payment: pay is refused and the sweeper marks the order EXPIRED", async () => {
    const o = await newOrder();
    await db.pool.query("UPDATE orders SET hold_expires_at = now() - interval '1 second', next_check_at = now() WHERE id = $1", [o.id]);
    await assert.rejects(pay(o), (e) => e.body.error === "hold_expired");
    await saga.sweepOnce();
    assert.equal((await state(o.id)).state, "EXPIRED");
    assert.equal(await capQty(`holder-${o.userId}`), 0);
  });

  test("customer pays but the seats are gone at confirm: refunded, cap released, order.refunded emitted", async () => {
    const o = await newOrder(randomUUID(), [{ tierId: TIER_ID, seatId: SEAT_ID }]);
    await pay(o);
    fakes.confirmResult = () => ({ status: 409, json: { error: "seats_unavailable" } });
    fakes.payments.get(await currentPayment(o.id)).status = "succeeded"; // the money was really taken
    await saga.applyPayment(o.id, await currentPayment(o.id), "succeeded");
    fakes.confirmResult = () => ({ status: 200, json: { ok: true } });
    const s = await state(o.id);
    assert.equal(s.state, "REFUNDED");
    assert.equal(fakes.calls.refund.at(-1), `refund:${s.current_payment_id}`);
    assert.equal(await capQty(`holder-${o.userId}`), 0);
    const [evt] = await outbox("order.refunded", o.id);
    assert.equal(evt.payload.reason, "seats_unavailable");
  });

  test("crash after payment (order stuck in PAID): the sweeper confirms it", async () => {
    const o = await newOrder();
    await pay(o);
    await db.pool.query("UPDATE orders SET state = 'PAID', next_check_at = now() WHERE id = $1", [o.id]); // as if booking died right after PAID
    await saga.sweepOnce();
    assert.equal((await state(o.id)).state, "CONFIRMED");
  });

  test("crash during refund (REFUND_PENDING): the sweeper finishes the refund", async () => {
    const o = await newOrder();
    await pay(o);
    const paymentId = await currentPayment(o.id);
    fakes.payments.get(paymentId).status = "succeeded";
    await db.pool.query("UPDATE orders SET state = 'REFUND_PENDING', failure_reason = 'sold_out', next_check_at = now() WHERE id = $1", [o.id]);
    await saga.sweepOnce();
    assert.equal((await state(o.id)).state, "REFUNDED");
    assert.equal(await capQty(`holder-${o.userId}`), 0);
  });

  test("lost callback and a hanging payment: after the deadline the sweeper cancels it and the order can retry", async () => {
    const o = await newOrder();
    await pay(o);
    await db.pool.query("UPDATE orders SET payment_deadline = now() - interval '1 second', next_check_at = now() WHERE id = $1", [o.id]);
    const cancels = fakes.calls.cancel;
    await saga.sweepOnce();
    assert.equal(fakes.calls.cancel, cancels + 1);
    assert.equal((await state(o.id)).state, "HELD");
  });

  test("a payment that succeeds after the order already failed is refunded, never kept", async () => {
    const o = await newOrder();
    await pay(o);
    const paymentId = await currentPayment(o.id);
    await db.pool.query("UPDATE orders SET state = 'FAILED', cap_held = false, current_payment_id = NULL WHERE id = $1", [o.id]);
    fakes.payments.get(paymentId).status = "succeeded";
    await saga.applyPayment(o.id, paymentId, "succeeded");
    const s = await state(o.id);
    assert.equal(s.state, "REFUNDED");
    assert.equal((await outbox("order.refunded", o.id))[0].payload.reason, "late_payment");
  });

  test("idempotency: the same key returns the same order, a changed body is rejected, and a repeated pay charges once", async () => {
    const userId = randomUUID();
    const k = key();
    const body = { eventId: EVENT_ID, items: [{ tierId: TIER_ID, quantity: 1 }] };
    const [a, b] = await Promise.all([saga.createOrder({ userId, key: k, body, requestId: "r" }), saga.createOrder({ userId, key: k, body, requestId: "r" })]);
    assert.equal(a.order.id, b.order.id);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM orders WHERE user_id = $1", [userId])).rows[0].n, 1);
    await assert.rejects(saga.createOrder({ userId, key: k, body: { ...body, items: [{ tierId: TIER_ID, quantity: 2 }] }, requestId: "r" }), (e) => e.status === 422);

    const creates = fakes.calls.create.length;
    const payKey = key();
    const o = { userId, id: a.order.id };
    await Promise.all([pay(o, payKey), pay(o, payKey)]);
    assert.equal(fakes.calls.create.length, creates + 1);
    assert.equal((await state(o.id)).attempts, 1);
  });

  test("a late 'failed' callback from attempt 1 does not disturb attempt 2", async () => {
    const o = await newOrder();
    await pay(o);
    const p1 = await currentPayment(o.id);
    await saga.applyPayment(o.id, p1, "failed");
    assert.equal((await state(o.id)).state, "HELD");
    await pay(o);
    assert.equal((await state(o.id)).attempts, 2);
    await saga.applyPayment(o.id, p1, "failed"); // retried callback for the old attempt
    const s2 = await state(o.id);
    assert.equal(s2.state, "PAYMENT_PENDING");
    assert.equal(s2.attempts, 2);
  });

  test("a second successful charge for an order is refunded, and the order stays confirmed", async () => {
    const o = await newOrder();
    await pay(o);
    const p1 = await currentPayment(o.id);
    fakes.payments.get(p1).status = "succeeded";
    await saga.applyPayment(o.id, p1, "succeeded");
    assert.equal((await state(o.id)).state, "CONFIRMED");
    const stray = randomUUID();
    fakes.payments.set(stray, { id: stray, status: "succeeded", orderId: o.id });
    await saga.applyPayment(o.id, stray, "succeeded");
    assert.ok(fakes.calls.refund.includes(`refund:${stray}`));
    assert.equal(fakes.payments.get(stray).status, "refunded");
    assert.equal((await state(o.id)).state, "CONFIRMED");
    const confirms = fakes.calls.confirm;
    await saga.applyPayment(o.id, p1, "succeeded"); // duplicate callback: nothing happens
    assert.equal(fakes.calls.confirm, confirms);
    assert.equal(fakes.payments.get(p1).status, "succeeded");
  });

  test("lost create reply: the sweeper finds the payment by its key and finishes the order", async () => {
    const o = await newOrder();
    fakes.createReply = () => { throw new Error("reply lost"); };
    await pay(o); // payOrder tolerates a lost reply: the order stays PAYMENT_PENDING for the sweeper
    fakes.createReply = null;
    const s1 = await state(o.id);
    assert.equal(s1.state, "PAYMENT_PENDING");
    assert.equal(s1.current_payment_id, null);
    const created = [...fakes.payments.values()].find((p) => p.key === `pay:${o.id}:1`);
    created.status = "succeeded"; // it really was charged
    await db.pool.query("UPDATE orders SET payment_deadline = now() - interval '1 second', next_check_at = now() WHERE id = $1", [o.id]);
    await saga.sweepOnce();
    assert.equal((await state(o.id)).state, "CONFIRMED");
  });

  test("lost create reply where nothing was ever created: the order goes back to HELD", async () => {
    const o = await newOrder();
    const real = fakes.clients.payment.create;
    fakes.clients.payment.create = async () => { throw new Error("never reached payment-service"); };
    await pay(o);
    fakes.clients.payment.create = real;
    await db.pool.query("UPDATE orders SET payment_deadline = now() - interval '1 second', next_check_at = now() WHERE id = $1", [o.id]);
    await saga.sweepOnce();
    assert.equal((await state(o.id)).state, "HELD");
  });

  test("reusing a pay key with a different card is rejected", async () => {
    const o = await newOrder();
    const k = key();
    await pay(o, k);
    await assert.rejects(saga.payOrder({ userId: o.userId, orderId: o.id, key: k, body: { ...card, card: { ...card.card, number: "4000 0000 0000 0002" } }, requestId: "r" }), (e) => e.status === 422);
  });

  test("seats lost while extending the hold: nothing is charged and the order fails with the cap released", async () => {
    const o = await newOrder();
    const creates = fakes.calls.create.length;
    fakes.extendResult = () => ({ status: 409, json: { error: "seats_unavailable" } });
    await assert.rejects(pay(o), (e) => e.body.error === "seats_unavailable");
    fakes.extendResult = () => ({ status: 200, json: { ok: true } });
    assert.equal(fakes.calls.create.length, creates);
    assert.equal((await state(o.id)).state, "FAILED");
    assert.equal(await capQty(`holder-${o.userId}`), 0);
  });

  test("an unsupported test instrument is not a real attempt: the order returns to HELD with attempts restored", async () => {
    const o = await newOrder();
    const real = fakes.clients.payment.create;
    fakes.clients.payment.create = async () => ({ status: 400, json: { error: "unsupported_test_instrument" } });
    await assert.rejects(pay(o), (e) => e.status === 400 && e.body.error === "unsupported_test_instrument");
    fakes.clients.payment.create = real;
    const s2 = await state(o.id);
    assert.equal(s2.state, "HELD");
    assert.equal(s2.attempts, 0);
    await pay(o); // can try again
    assert.equal((await state(o.id)).state, "PAYMENT_PENDING");
  });

  test("a hold request that never answered leaves the order PENDING; the sweeper fails it and frees the cap", async () => {
    const userId = randomUUID();
    const real = fakes.clients.inventory.hold;
    fakes.clients.inventory.hold = async () => { throw new Error("inventory down"); };
    await assert.rejects(saga.createOrder({ userId, key: key(), body: { eventId: EVENT_ID, items: [{ tierId: TIER_ID, quantity: 1 }] }, requestId: "r" }), (e) => e.status === 503);
    fakes.clients.inventory.hold = real;
    const { rows } = await db.pool.query("SELECT id, state FROM orders WHERE user_id = $1", [userId]);
    assert.equal(rows[0].state, "PENDING");
    await db.pool.query("UPDATE orders SET created_at = now() - interval '2 minutes', next_check_at = now() WHERE id = $1", [rows[0].id]);
    await saga.sweepOnce();
    assert.equal((await state(rows[0].id)).state, "FAILED");
    assert.equal(await capQty(`holder-${userId}`), 0);
  });

  test("two sweepers at once handle each expired order exactly once", async () => {
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push(await newOrder());
    await db.pool.query("UPDATE orders SET hold_expires_at = now() - interval '1 second', next_check_at = now() WHERE id = ANY($1)", [orders.map((o) => o.id)]);
    const released = fakes.calls.release;
    const [a, b] = await Promise.all([saga.sweepOnce(), saga.sweepOnce()]);
    assert.ok(a + b >= 6);
    for (const o of orders) assert.equal((await state(o.id)).state, "EXPIRED");
    assert.equal(fakes.calls.release - released, 6); // not 12: no order was worked twice
  });

  test("duplicate and concurrent success callbacks confirm and charge once", async () => {
    const o = await newOrder();
    await pay(o);
    const p = await currentPayment(o.id);
    fakes.payments.get(p).status = "succeeded";
    const confirms = fakes.calls.confirm;
    await Promise.all([saga.applyPayment(o.id, p, "succeeded"), saga.applyPayment(o.id, p, "succeeded"), saga.applyPayment(o.id, p, "succeeded")]);
    assert.equal((await state(o.id)).state, "CONFIRMED");
    assert.equal(fakes.calls.confirm - confirms, 1);
    assert.equal((await outbox("order.confirmed", o.id)).length, 1);
  });

  test("callback route: valid signature accepted; bad signature, stale timestamp and non-ASCII header all get 401", async () => {
    const { buildApp } = await import("../src/app.js");
    const secret = "test-webhook-secret-test-webhook-secret";
    const app = await buildApp({ pool: db.pool, saga, logger: silentLogger, config: { webhookSecret: secret } });
    const o = await newOrder();
    await pay(o);
    const p = await currentPayment(o.id);
    fakes.payments.get(p).status = "succeeded";
    const raw = JSON.stringify({ paymentId: p, orderId: o.id, status: "succeeded", occurredAt: new Date().toISOString() });
    const sign = (ts, body = raw) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const post = (headers, body = raw) => app.inject({ method: "POST", url: "/internal/payments/callback", headers: { "content-type": "application/json", ...headers }, payload: body });
    const ts = String(Date.now());

    assert.equal((await post({ "x-timestamp": ts, "x-signature": "0".repeat(64) })).statusCode, 401);
    assert.equal((await post({ "x-timestamp": ts, "x-signature": "é".repeat(64) })).statusCode, 401);
    const stale = String(Date.now() - 10 * 60_000);
    assert.equal((await post({ "x-timestamp": stale, "x-signature": sign(stale) })).statusCode, 401);
    assert.equal((await post({ "x-timestamp": ts, "x-signature": sign(ts) }, raw.replace("succeeded", "failed"))).statusCode, 401); // body tampered after signing
    assert.equal((await state(o.id)).state, "PAYMENT_PENDING");
    assert.equal((await post({ "x-timestamp": ts, "x-signature": sign(ts) })).statusCode, 200);
    assert.equal((await state(o.id)).state, "CONFIRMED");
    await app.close();
  });

  test("if refunding a second charge fails, the error surfaces so the callback is retried", async () => {
    const o = await newOrder();
    await pay(o);
    const p1 = await currentPayment(o.id);
    fakes.payments.get(p1).status = "succeeded";
    await saga.applyPayment(o.id, p1, "succeeded");
    const stray = randomUUID();
    fakes.payments.set(stray, { id: stray, status: "succeeded", orderId: o.id });
    const real = fakes.clients.payment.refund;
    fakes.clients.payment.refund = async () => ({ status: 503, json: {} });
    await assert.rejects(saga.applyPayment(o.id, stray, "succeeded"));
    fakes.clients.payment.refund = real;
    await saga.applyPayment(o.id, stray, "succeeded"); // the retried callback now succeeds
    assert.equal(fakes.payments.get(stray).status, "refunded");
  });

  test("a stale sweeper answer for attempt 1 is ignored once the order is on attempt 2", async () => {
    const o = await newOrder();
    await pay(o);
    const p1 = await currentPayment(o.id);
    await saga.applyPayment(o.id, p1, "failed");
    await pay(o);
    await saga.applyPayment(o.id, p1, "cancelled", undefined, { trusted: true, attempt: 1 });
    const s2 = await state(o.id);
    assert.equal(s2.state, "PAYMENT_PENDING");
    assert.equal(s2.attempts, 2);
  });
});
