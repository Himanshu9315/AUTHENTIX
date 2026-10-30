import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { encodeToken, stepAt } from "../src/qr.js";
import { insertTicket, makeDb, skip } from "./helpers.js";

describe("one-time entry", { skip }, () => {
  let db, admit;
  const key = randomBytes(32);
  const eventId = randomUUID();
  let clock = Date.now();
  const staff = randomUUID();

  before(async () => {
    const { createAdmitter } = await import("../src/admission.js");
    db = await makeDb();
    admit = createAdmitter({ pool: db.pool, masterKey: key, graceSeconds: 120, now: () => clock });
  });
  after(() => db?.drop());

  const token = (ticketId, version = 1, delta = 0) => encodeToken(key, ticketId, version, stepAt(clock) + delta);
  const scan = (ticketId, over = {}) =>
    admit({ token: token(ticketId), eventId, scanId: randomUUID(), gateId: "G1", staffUserId: staff, scannedAt: new Date(clock).toISOString(), ...over });
  const ticket = (over) => insertTicket(db.pool, { eventId, ...over });

  test("a valid QR is admitted and shows the holder's first name and last initial", async () => {
    const id = await ticket({ display: "Asha K." });
    const r = await scan(id);
    assert.equal(r.result, "admitted");
    assert.equal(r.holderName, "Asha K.");
    assert.equal(r.usedGate, "G1");
  });

  test("20 gates scan the same QR at once: exactly one is admitted and 19 are told it was already used", async () => {
    const id = await ticket();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => scan(id, { gateId: `G${i}` })));
    assert.equal(results.filter((r) => r.result === "admitted").length, 1);
    const rejects = results.filter((r) => r.result === "rejected");
    assert.equal(rejects.length, 19);
    assert.ok(rejects.every((r) => r.reason === "already_used" && r.usedAt && r.usedGate));
    assert.equal((await db.pool.query("SELECT status FROM tickets WHERE id = $1", [id])).rows[0].status, "used");
  });

  test("a retried scan with the same scanId gets the same admitted answer and changes nothing", async () => {
    const id = await ticket();
    const scanId = randomUUID();
    const first = await scan(id, { scanId });
    const again = await scan(id, { scanId });
    assert.equal(first.result, "admitted");
    assert.equal(again.result, "admitted");
    assert.equal((await db.pool.query("SELECT used_scan_id FROM tickets WHERE id = $1", [id])).rows[0].used_scan_id, scanId);
    assert.equal((await scan(id, { scanId: randomUUID() })).reason, "already_used"); // a different scan is not a retry
  });

  test("the previous step's code is rejected after the ticket was used", async () => {
    const id = await ticket();
    await scan(id);
    const r = await scan(id, { token: token(id, 1, -1) });
    assert.equal(r.reason, "already_used");
  });

  test("a ticket for another event is rejected as wrong_event", async () => {
    const id = await insertTicket(db.pool, { eventId: randomUUID() });
    assert.equal((await scan(id)).reason, "wrong_event");
  });

  test("after a transfer (version bump) the old QR is ticket_replaced and the new QR is admitted", async () => {
    const id = await ticket();
    await db.pool.query("UPDATE tickets SET version = 2 WHERE id = $1", [id]);
    assert.equal((await scan(id, { token: token(id, 1) })).reason, "ticket_replaced");
    assert.equal((await scan(id, { token: token(id, 2) })).result, "admitted");
  });

  test("a void ticket is ticket_void", async () => {
    const id = await ticket({ status: "void" });
    assert.equal((await scan(id)).reason, "ticket_void");
  });

  test("expired and forged codes are rejected without touching the ticket", async () => {
    const id = await ticket();
    assert.equal((await scan(id, { token: token(id, 1, -2) })).reason, "qr_expired");
    assert.equal((await scan(id, { token: token(id, 1, 2) })).reason, "qr_expired");
    assert.equal((await scan(id, { token: "x".repeat(55) })).reason, "invalid_qr");
    assert.equal((await db.pool.query("SELECT status FROM tickets WHERE id = $1", [id])).rows[0].status, "active");
  });

  test("a queued scan older than the grace period needs a rescan; a recent one is judged when it was captured", async () => {
    const id = await ticket();
    const old = new Date(clock - 130_000).toISOString();
    assert.equal((await scan(id, { scannedAt: old, token: token(id, 1, -4) })).reason, "scan_stale");
    // captured 100 s ago with the code that was showing then: still fine
    clock += 100_000;
    const captured = new Date(clock - 100_000).toISOString();
    const t = encodeToken(key, id, 1, stepAt(clock - 100_000));
    assert.equal((await scan(id, { scannedAt: captured, token: t })).result, "admitted");
  });

  test("a scanner clock running ahead is clamped to the server's time, not trusted", async () => {
    const id = await ticket();
    const future = new Date(clock + 10 * 60_000).toISOString();
    // a code from 10 minutes in the future must NOT be accepted just because the device says it is that time
    assert.equal((await scan(id, { scannedAt: future, token: encodeToken(key, id, 1, stepAt(clock + 10 * 60_000)) })).reason, "qr_expired");
    assert.equal((await scan(id, { scannedAt: future })).result, "admitted"); // the current code still works
  });

  test("the old QR of a ticket that was transferred and then used says ticket_replaced, not already_used", async () => {
    const id = await ticket();
    await db.pool.query("UPDATE tickets SET version = 2, status = 'used', used_scan_id = $2, used_at = now() WHERE id = $1", [id, randomUUID()]);
    assert.equal((await scan(id, { token: token(id, 1) })).reason, "ticket_replaced");
    assert.equal((await scan(id, { token: token(id, 2) })).reason, "already_used"); // the current QR really was used
  });

  test("a scan retry only counts as the same scan if the QR version matches", async () => {
    const id = await ticket();
    const scanId = randomUUID();
    assert.equal((await scan(id, { scanId })).result, "admitted");
    await db.pool.query("UPDATE tickets SET version = 2 WHERE id = $1", [id]); // transferred after entry, oddly
    assert.equal((await scan(id, { scanId, token: token(id, 1) })).reason, "ticket_replaced");
  });

  test("an upper-case event id behaves exactly like a lower-case one", async () => {
    const id = await ticket();
    assert.equal((await scan(id, { eventId: eventId.toUpperCase() })).result, "admitted");
    assert.equal((await scan(id, { eventId: eventId.toUpperCase() })).reason, "already_used");
  });
});
