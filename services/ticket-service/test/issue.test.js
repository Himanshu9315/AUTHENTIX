import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDb, silentLogger, skip } from "./helpers.js";

describe("ticket issuance from order.confirmed", { skip }, () => {
  let db, issue, users;
  before(async () => {
    const { createIssuer, holderDisplay } = await import("../src/issue.js");
    db = await makeDb();
    users = new Map();
    issue = createIssuer({ pool: db.pool, clients: { getUser: async (id) => (users.has(id) ? { status: 200, json: { name: users.get(id) } } : { status: 404, json: {} }) } });
    void holderDisplay;
  });
  after(() => db?.drop());

  const event = (userId, items) => ({ id: randomUUID(), type: "order.confirmed", occurredAt: new Date().toISOString(), payload: { orderId: randomUUID(), userId, eventId: randomUUID(), items, totalInr: 3000, confirmedAt: new Date().toISOString() } });

  test("one ticket per seat and per general-admission unit; a redelivered event changes nothing and emits nothing more", async () => {
    const userId = randomUUID();
    users.set(userId, "Asha Kulkarni");
    const tier = randomUUID();
    const e = event(userId, [
      { tierId: tier, seatId: randomUUID(), seatLabel: "Stalls D-1", quantity: 1, unitPriceInr: 1000 },
      { tierId: tier, seatId: null, seatLabel: null, quantity: 2, unitPriceInr: 1000 },
    ]);
    await issue(e);
    await issue(e);
    await issue(structuredClone(e)); // redelivered
    const { rows } = await db.pool.query("SELECT holder_display, seat_label, version FROM tickets WHERE order_id = $1 ORDER BY seat_label NULLS LAST", [e.payload.orderId]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.holder_display === "Asha K." && r.version === 1));
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'ticket.issued' AND payload->>'orderId' = $1", [e.payload.orderId])).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ticket_owners WHERE ticket_id IN (SELECT id FROM tickets WHERE order_id = $1)", [e.payload.orderId])).rows[0].n, 3);
  });

  test("a bad payload and a missing holder are permanent errors (parked, not retried forever)", async () => {
    const { PermanentError } = await import("@authentix/events");
    await assert.rejects(issue({ id: "x", type: "order.confirmed", payload: { nope: true } }), PermanentError);
    await assert.rejects(issue(event(randomUUID(), [{ tierId: randomUUID(), seatId: null, seatLabel: null, quantity: 1, unitPriceInr: 1 }])), PermanentError);
  });

  test("an unreachable auth-service is a retryable error, and nothing is half-written", async () => {
    const { createIssuer } = await import("../src/issue.js");
    const down = createIssuer({ pool: db.pool, clients: { getUser: async () => { throw new Error("down"); } } });
    const e = event(randomUUID(), [{ tierId: randomUUID(), seatId: null, seatLabel: null, quantity: 1, unitPriceInr: 1 }]);
    await assert.rejects(down(e), (err) => err.constructor.name === "Error");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM tickets WHERE order_id = $1", [e.payload.orderId])).rows[0].n, 0);
  });

  test("names become first name plus last initial, and a single name stays whole", async () => {
    const { holderDisplay } = await import("../src/issue.js");
    assert.equal(holderDisplay("Asha Kulkarni"), "Asha K.");
    assert.equal(holderDisplay("  Ravi   Kumar  Menon "), "Ravi M.");
    assert.equal(holderDisplay("Cher"), "Cher");
    assert.equal(holderDisplay("   "), "Guest");
  });
});
