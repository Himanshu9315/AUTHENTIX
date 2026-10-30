import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signAdmission } from "@authentix/internal";
import { EVENT_ID, TIER_ID, makeDb, makeFakes, silentLogger, skip } from "./helpers.js";

const SECRET = "a".repeat(40);

describe("hot-sale events need an admission from the waiting room", { skip }, () => {
  let db, fakes, saga;
  before(async () => {
    const { createSaga } = await import("../src/saga.js");
    db = await makeDb();
    fakes = makeFakes();
    saga = createSaga({ pool: db.pool, clients: fakes.clients, logger: silentLogger, config: { admissionSecret: SECRET } });
  });
  after(() => db?.drop());

  const body = { eventId: EVENT_ID, items: [{ tierId: TIER_ID, quantity: 1 }] };
  const book = (userId, admissionToken, key = `key-${randomUUID()}`) =>
    saga.createOrder({ userId, key, body, requestId: "r", admissionToken }).then((r) => ({ ok: true, order: r.order }), (e) => ({ ok: false, status: e.status, error: e.body?.error }));
  const token = (userId, over = {}) => signAdmission(SECRET, { userId, eventId: EVENT_ID, expiresAtMs: Date.now() + 600_000, ...over });
  const orders = async () => (await db.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;

  test("an ordinary event needs no token", async () => {
    fakes.hotSale = false;
    assert.equal((await book(randomUUID(), undefined)).ok, true);
  });

  test("a hot-sale event refuses no token, a forged token, another person's token, another event's token and an expired one, and creates nothing", async () => {
    fakes.hotSale = true;
    const before = await orders();
    const holdsBefore = fakes.calls.hold;
    const me = randomUUID();
    const cases = [
      [undefined, "admission_required"],
      ["", "admission_required"],
      ["v1.garbage.garbage", "admission_invalid"],
      [signAdmission("z".repeat(40), { userId: me, eventId: EVENT_ID, expiresAtMs: Date.now() + 600_000 }), "admission_invalid"],
      [token(randomUUID()), "admission_invalid"],
      [token(me, { eventId: randomUUID() }), "admission_invalid"],
      [token(me, { expiresAtMs: Date.now() - 1000 }), "admission_expired"],
    ];
    for (const [t, error] of cases) {
      const r = await book(me, t);
      assert.deepEqual([r.ok, r.status, r.error], [false, 403, error], String(t).slice(0, 30));
    }
    assert.equal(await orders(), before);
    assert.equal(fakes.calls.hold, holdsBefore); // no seats were ever held for any of them
  });

  test("a valid admission lets the person book, and the ticket cap still applies to them", async () => {
    fakes.hotSale = true;
    const me = randomUUID();
    assert.equal((await book(me, token(me))).ok, true);
    const four = await saga.createOrder({ userId: me, key: `key-${randomUUID()}`, body: { eventId: EVENT_ID, items: [{ tierId: TIER_ID, quantity: 4 }] }, requestId: "r", admissionToken: token(me) }).catch((e) => e);
    assert.equal(four.body?.error, "ticket_cap_exceeded");
  });

  test("repeating an order that already exists does not need the token again (the order is already theirs)", async () => {
    fakes.hotSale = true;
    const me = randomUUID();
    const key = `key-${randomUUID()}`;
    const first = await book(me, token(me), key);
    assert.equal(first.ok, true);
    const again = await book(me, undefined, key);
    assert.deepEqual([again.ok, again.order.id], [true, first.order.id]);
  });

  test("with no admission secret configured, hot-sale booking is refused rather than allowed", async () => {
    const { createSaga } = await import("../src/saga.js");
    const open = createSaga({ pool: db.pool, clients: fakes.clients, logger: silentLogger, config: {} });
    fakes.hotSale = true;
    const me = randomUUID();
    const r = await open.createOrder({ userId: me, key: `key-${randomUUID()}`, body, requestId: "r", admissionToken: token(me) }).catch((e) => e);
    assert.equal(r.status, 503);
  });
});
