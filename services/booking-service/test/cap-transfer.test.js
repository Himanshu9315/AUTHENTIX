import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDb, silentLogger, skip } from "./helpers.js";

describe("cap transfers (ticket transfers between Aadhaar holders)", { skip }, () => {
  let db, ct;
  const eventId = randomUUID();
  const events = { cap: 4 };
  const clients = { getEvent: async () => ({ status: 200, json: { ticketCap: events.cap } }) };

  before(async () => {
    const { createCapTransfers } = await import("../src/captransfer.js");
    db = await makeDb();
    ct = createCapTransfers({ pool: db.pool, clients, logger: silentLogger });
  });
  after(() => db?.drop());

  const seed = (key, qty) => db.pool.query("INSERT INTO cap_usage (event_id, holder_key, qty) VALUES ($1,$2,$3) ON CONFLICT (event_id, holder_key) DO UPDATE SET qty = $3", [eventId, key, qty]);
  const qty = async (key) => (await db.pool.query("SELECT qty FROM cap_usage WHERE event_id = $1 AND holder_key = $2", [eventId, key])).rows[0]?.qty ?? 0;
  const keys = () => ({ from: `from-${randomUUID()}`, to: `to-${randomUUID()}` });
  const reserve = (id, k) => ct.reserve({ transferId: id, eventId, fromHolderKey: k.from, toHolderKey: k.to }, "r");
  const revertBody = (k) => ({ eventId, fromHolderKey: k.from, toHolderKey: k.to });

  test("cap 4, recipient already holds 2: 5 parallel reserves let exactly 2 through", async () => {
    const k = keys();
    await seed(k.to, 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(randomUUID(), k)));
    assert.equal(results.filter((r) => r.status === 200 && r.body.state === "reserved").length, 2);
    assert.equal(results.filter((r) => r.status === 409 && r.body.error === "ticket_cap_exceeded").length, 3);
    assert.equal(await qty(k.to), 4);
  });

  test("commit releases the sender exactly once, even if repeated", async () => {
    const k = keys();
    await seed(k.from, 3);
    const id = randomUUID();
    assert.equal((await reserve(id, k)).body.state, "reserved");
    assert.equal(await qty(k.from), 3); // still counted until the ticket has really moved
    assert.deepEqual((await ct.commit(id)).body, { state: "committed" });
    assert.deepEqual((await ct.commit(id)).body, { state: "committed" });
    await Promise.all([ct.commit(id), ct.commit(id)]);
    assert.equal(await qty(k.from), 2);
    assert.equal(await qty(k.to), 1);
  });

  test("a repeated reserve for the same transfer does not charge the recipient twice", async () => {
    const k = keys();
    const id = randomUUID();
    await Promise.all([reserve(id, k), reserve(id, k), reserve(id, k)]);
    assert.equal(await qty(k.to), 1);
  });

  test("reverting a reserved transfer gives the recipient's unit back; repeating it changes nothing", async () => {
    const k = keys();
    const id = randomUUID();
    await reserve(id, k);
    assert.equal(await qty(k.to), 1);
    assert.equal((await ct.revert(id, revertBody(k))).status, 200);
    assert.equal((await ct.revert(id, revertBody(k))).status, 200);
    assert.equal(await qty(k.to), 0);
  });

  test("a revert that arrives before its reserve leaves a tombstone, so the late reserve never applies", async () => {
    const k = keys();
    const id = randomUUID();
    assert.equal((await ct.revert(id, revertBody(k))).body.state, "reverted");
    const late = await reserve(id, k);
    assert.deepEqual([late.status, late.body.state], [200, "reverted"]);
    assert.equal(await qty(k.to), 0);
  });

  test("reverting after commit is refused, and committing after revert is refused", async () => {
    const k = keys();
    const a = randomUUID();
    await reserve(a, k);
    await ct.commit(a);
    assert.equal((await ct.revert(a, revertBody(k))).status, 409);
    const b = randomUUID();
    await reserve(b, k);
    await ct.revert(b, revertBody(k));
    assert.equal((await ct.commit(b)).status, 409);
    assert.equal((await ct.commit(randomUUID())).status, 404);
  });

  test("reserve racing revert on the same id always ends reverted with the recipient's count back to zero", async () => {
    for (let i = 0; i < 10; i++) {
      const k = keys();
      const id = randomUUID();
      await Promise.all([reserve(id, k), ct.revert(id, revertBody(k))]);
      assert.equal((await db.pool.query("SELECT state FROM cap_transfers WHERE id = $1", [id])).rows[0].state, "reverted");
      assert.equal(await qty(k.to), 0);
    }
  });

  test("catalog being down refuses the reserve instead of guessing a cap", async () => {
    const down = { getEvent: async () => { throw new Error("down"); } };
    const { createCapTransfers } = await import("../src/captransfer.js");
    const r = await createCapTransfers({ pool: db.pool, clients: down, logger: silentLogger }).reserve({ transferId: randomUUID(), eventId, fromHolderKey: "a".repeat(10), toHolderKey: "b".repeat(10) }, "r");
    assert.equal(r.status, 503);
  });
});
