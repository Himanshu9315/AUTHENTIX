import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { encodeToken, stepAt } from "../src/qr.js";
import { insertTicket, makeDb, silentLogger, skip } from "./helpers.js";

describe("ticket transfers", { skip }, () => {
  let db, tr, admit, fx;
  const key = randomBytes(32);
  const eventId = randomUUID();
  const staff = randomUUID();
  const day = 86_400_000;

  const makeFixture = () => {
    const f = {
      startsAt: Date.now() + 10 * day,
      users: new Map(), // email -> { id, name, emailVerified }
      holders: new Map(), // userId -> { verified, holderKey }
      capReserve: () => ({ status: 200, json: { state: "reserved" } }),
      capCommit: () => ({ status: 200, json: { state: "committed" } }),
      capRevert: () => ({ status: 200, json: { state: "reverted" } }),
      calls: { reserve: 0, commit: 0, revert: 0 },
      eventDown: false,
    };
    f.person = (email, { name = "Ravi Menon", emailVerified = true, aadhaar = true } = {}) => {
      const id = randomUUID();
      f.users.set(email, { id, name, emailVerified });
      f.holders.set(id, aadhaar ? { verified: true, holderKey: `key-${id}` } : { verified: false });
      return id;
    };
    f.clients = {
      getEvent: async () => {
        if (f.eventDown) throw new Error("down");
        return { status: 200, json: { startsAt: new Date(f.startsAt).toISOString(), status: "published" } };
      },
      lookupUser: async (email) => (f.users.has(email) ? { status: 200, json: f.users.get(email) } : { status: 404, json: {} }),
      getHolder: async (id) => ({ status: 200, json: f.holders.get(id) ?? { verified: false } }),
      cap: {
        reserve: async (b) => (f.calls.reserve++, f.capReserve(b)),
        commit: async (id) => (f.calls.commit++, f.capCommit(id)),
        revert: async (id, b) => (f.calls.revert++, f.capRevert(id, b)),
      },
    };
    return f;
  };

  before(async () => {
    const { createTransfers } = await import("../src/transfers.js");
    const { createAdmitter } = await import("../src/admission.js");
    db = await makeDb();
    fx = makeFixture();
    tr = createTransfers({ pool: db.pool, clients: fx.clients, logger: silentLogger, config: { leaseSeconds: 0, pendingSeconds: 0 } });
    admit = createAdmitter({ pool: db.pool, masterKey: key, graceSeconds: 120 });
  });
  after(() => db?.drop());

  const idem = () => `key-${randomUUID()}`;
  const go = (owner, ticketId, email, k = idem()) => tr.transfer({ userId: owner, ticketId, key: k, recipientEmail: email, requestId: "r" });
  const setup = async (over = {}) => {
    const owner = fx.person(`owner-${randomUUID()}@example.test`, { name: "Asha Kulkarni" });
    const ticketId = await insertTicket(db.pool, { eventId, ownerId: owner, ...over });
    return { owner, ticketId };
  };
  const row = async (id) => (await db.pool.query("SELECT * FROM tickets WHERE id = $1", [id])).rows[0];
  const scan = (ticketId, version) =>
    admit({ token: encodeToken(key, ticketId, version, stepAt(Date.now())), eventId, scanId: randomUUID(), gateId: "G1", staffUserId: staff, scannedAt: new Date().toISOString() });

  test("happy path: new owner, new version, history row and one ticket.transferred event; the old QR dies, the new one works", async () => {
    const { owner, ticketId } = await setup();
    const to = fx.person("ravi@example.test", { name: "Ravi Menon" });
    const r = await go(owner, ticketId, "ravi@example.test");
    assert.deepEqual([r.status, r.body.state], [200, "done"]);
    const t = await row(ticketId);
    assert.deepEqual([t.owner_user_id, t.version, t.transfer_count, t.holder_display], [to, 2, 1, "Ravi M."]);
    const hist = await db.pool.query("SELECT version, reason, from_user_id FROM ticket_owners WHERE ticket_id = $1 ORDER BY version", [ticketId]);
    assert.deepEqual(hist.rows.map((h) => [h.version, h.reason]), [[2, "transfer"]]);
    const ev = await db.pool.query("SELECT payload FROM outbox WHERE type = 'ticket.transferred' AND payload->>'ticketId' = $1", [ticketId]);
    assert.equal(ev.rows.length, 1);
    assert.deepEqual(Object.keys(ev.rows[0].payload).sort(), ["eventId", "fromUserId", "newVersion", "ticketId", "toUserId", "transferId", "transferredAt"]);
    assert.equal((await scan(ticketId, 1)).reason, "ticket_replaced");
    assert.equal((await scan(ticketId, 2)).result, "admitted");
    // the sender is released only after the move
    assert.equal((await db.pool.query("SELECT cap_settled FROM transfers WHERE id = $1", [r.body.transferId])).rows[0].cap_settled, true);
  });

  test("the sender can no longer see or move the ticket they gave away", async () => {
    const { owner, ticketId } = await setup();
    fx.person("kiran@example.test");
    await go(owner, ticketId, "kiran@example.test");
    assert.equal((await go(owner, ticketId, "kiran@example.test")).status, 404);
  });

  test("a third transfer is refused (2 per ticket)", async () => {
    const { owner, ticketId } = await setup();
    await db.pool.query("UPDATE tickets SET transfer_count = 2 WHERE id = $1", [ticketId]);
    fx.person("third@example.test");
    assert.deepEqual((await go(owner, ticketId, "third@example.test")).body, { error: "transfer_limit_reached" });
  });

  test("within 24 hours of the event, transfers are closed; catalog down fails closed", async () => {
    const { owner, ticketId } = await setup();
    fx.person("late@example.test");
    fx.startsAt = Date.now() + 23 * 3_600_000;
    assert.deepEqual((await go(owner, ticketId, "late@example.test")).body, { error: "transfer_window_closed" });
    fx.startsAt = Date.now() + 25 * 3_600_000;
    assert.equal((await go(owner, ticketId, "late@example.test")).status, 200);
    const t2 = await setup();
    fx.eventDown = true;
    assert.equal((await go(t2.owner, t2.ticketId, "late@example.test")).status, 503);
    fx.eventDown = false;
    fx.startsAt = Date.now() + 10 * day;
  });

  test("an unreadable event date fails closed", async () => {
    const { owner, ticketId } = await setup();
    fx.person("baddate@example.test");
    const real = fx.clients.getEvent;
    fx.clients.getEvent = async () => ({ status: 200, json: { startsAt: "garbage" } });
    const r = await go(owner, ticketId, "baddate@example.test");
    fx.clients.getEvent = real;
    assert.equal(r.status, 503);
    assert.equal((await row(ticketId)).owner_user_id, owner);
  });

  test("unknown, unverified-email, unverified-Aadhaar and cap-full recipients all get the identical response", async () => {
    const { owner, ticketId } = await setup();
    fx.person("noemail@example.test", { emailVerified: false });
    fx.person("noaadhaar@example.test", { aadhaar: false });
    fx.person("capfull@example.test");
    const bodies = [];
    for (const email of ["ghost@example.test", "noemail@example.test", "noaadhaar@example.test"]) {
      const r = await go(owner, ticketId, email);
      bodies.push([r.status, JSON.stringify(r.body)]);
    }
    fx.capReserve = () => ({ status: 409, json: { error: "ticket_cap_exceeded" } });
    const capFull = await go(owner, ticketId, "capfull@example.test");
    fx.capReserve = () => ({ status: 200, json: { state: "reserved" } });
    bodies.push([capFull.status, JSON.stringify(capFull.body)]);
    assert.equal(new Set(bodies.map((b) => b.join("|"))).size, 1, JSON.stringify(bodies));
    assert.deepEqual(bodies[0], [422, JSON.stringify({ error: "recipient_not_eligible" })]);
    assert.equal((await row(ticketId)).owner_user_id, owner); // nothing moved
  });

  test("you cannot transfer to yourself", async () => {
    const { owner, ticketId } = await setup();
    const email = `me-${randomUUID()}@example.test`;
    fx.users.set(email, { id: owner, name: "Asha K", emailVerified: true });
    assert.deepEqual((await go(owner, ticketId, email)).body, { error: "cannot_transfer_to_self" });
  });

  test("a used ticket cannot be transferred", async () => {
    const { owner, ticketId } = await setup({ status: "used" });
    fx.person("used@example.test");
    assert.deepEqual((await go(owner, ticketId, "used@example.test")).body, { error: "ticket_used" });
  });

  test("a transfer racing a gate scan: exactly one wins, and a losing transfer is failed with its cap reverted", async () => {
    for (let i = 0; i < 12; i++) {
      const { owner, ticketId } = await setup();
      fx.person(`race${i}@example.test`);
      const reverts = fx.calls.revert;
      const reserves = fx.calls.reserve;
      const [t, s] = await Promise.all([go(owner, ticketId, `race${i}@example.test`), scan(ticketId, 1)]);
      const row1 = await row(ticketId);
      if (t.status === 200) {
        assert.equal(row1.version, 2, "transfer won");
        assert.equal(s.reason, "ticket_replaced");
      } else {
        assert.equal(t.status, 409, JSON.stringify(t.body));
        assert.equal(s.result, "admitted");
        assert.equal(row1.status, "used");
        assert.equal(row1.version, 1);
        // Whatever was reserved for the losing transfer must be given back (nothing was reserved if it was refused up front).
        assert.equal(fx.calls.revert - reverts, fx.calls.reserve - reserves, "every reserve is matched by a revert");
        const tr1 = (await db.pool.query("SELECT state, cap_settled FROM transfers WHERE ticket_id = $1", [ticketId])).rows[0];
        if (fx.calls.reserve > reserves) assert.deepEqual([tr1.state, tr1.cap_settled], ["failed", true]);
        else assert.equal(tr1, undefined);
      }
    }
  });

  test("two transfers of one ticket at once: one is done, the other is refused", async () => {
    const { owner, ticketId } = await setup();
    fx.person("p1@example.test");
    fx.person("p2@example.test");
    const [a, b] = await Promise.all([go(owner, ticketId, "p1@example.test"), go(owner, ticketId, "p2@example.test")]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const t = await row(ticketId);
    assert.deepEqual([t.version, t.transfer_count], [2, 1]);
  });

  test("the same request repeated returns the same transfer and moves the ticket once", async () => {
    const { owner, ticketId } = await setup();
    fx.person("again@example.test");
    const k = idem();
    const [a, b] = await Promise.all([go(owner, ticketId, "again@example.test", k), go(owner, ticketId, "again@example.test", k)]);
    assert.equal(a.body.transferId, b.body.transferId);
    assert.equal((await go(owner, ticketId, "again@example.test", k)).body.state, "done");
    assert.equal((await row(ticketId)).version, 2);
    assert.equal((await go(owner, ticketId, "someone-else@example.test", k)).status, 422); // same key, different body
  });

  test("reserve gets no answer: the transfer stays pending, then the sweeper fails it and reverts the cap", async () => {
    const { owner, ticketId } = await setup();
    fx.person("slow@example.test");
    const real = fx.clients.cap.reserve;
    fx.clients.cap.reserve = async () => { throw new Error("booking unreachable"); };
    const r = await go(owner, ticketId, "slow@example.test");
    fx.clients.cap.reserve = real;
    assert.equal(r.status, 503);
    const reverts = fx.calls.revert;
    await tr.sweepOnce();
    const t = (await db.pool.query("SELECT state, cap_settled FROM transfers WHERE ticket_id = $1", [ticketId])).rows[0];
    assert.deepEqual([t.state, t.cap_settled], ["failed", true]);
    assert.equal(fx.calls.revert, reverts + 1);
    assert.equal((await row(ticketId)).owner_user_id, owner);
  });

  test("the ticket moved but the sender's release failed: the sweeper commits it later", async () => {
    const { owner, ticketId } = await setup();
    fx.person("commitlater@example.test");
    fx.capCommit = () => ({ status: 503, json: {} });
    const r = await go(owner, ticketId, "commitlater@example.test");
    fx.capCommit = () => ({ status: 200, json: { state: "committed" } });
    assert.equal(r.status, 200);
    assert.equal((await db.pool.query("SELECT cap_settled FROM transfers WHERE id = $1", [r.body.transferId])).rows[0].cap_settled, false);
    await tr.sweepOnce();
    assert.equal((await db.pool.query("SELECT cap_settled FROM transfers WHERE id = $1", [r.body.transferId])).rows[0].cap_settled, true);
  });

  test("the ticket is scanned in after the cap was reserved but before the move: the transfer fails and the reserve is reverted", async () => {
    const { owner, ticketId } = await setup();
    fx.person("toolate@example.test");
    fx.capReserve = async () => {
      await db.pool.query("UPDATE tickets SET status = 'used', used_at = now() WHERE id = $1", [ticketId]); // the gate got there first
      return { status: 200, json: { state: "reserved" } };
    };
    const reverts = fx.calls.revert;
    const r = await go(owner, ticketId, "toolate@example.test");
    fx.capReserve = () => ({ status: 200, json: { state: "reserved" } });
    assert.deepEqual([r.status, r.body.error], [409, "ticket_used"]);
    assert.equal(fx.calls.revert, reverts + 1);
    const t = (await db.pool.query("SELECT state, failure_reason, cap_settled FROM transfers WHERE ticket_id = $1", [ticketId])).rows[0];
    assert.deepEqual([t.state, t.failure_reason, t.cap_settled], ["failed", "ticket_changed", true]);
    const tk = await row(ticketId);
    assert.deepEqual([tk.owner_user_id, tk.version], [owner, 1]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'ticket.transferred' AND payload->>'ticketId' = $1", [ticketId])).rows[0].n, 0);
  });
});
