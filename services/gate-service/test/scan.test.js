import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.TEST_PG_URL;
const skip = adminUrl ? false : "TEST_PG_URL not set (needs the dev Postgres from docker compose)";
const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, level: "silent" };

describe("gate scans", { skip }, () => {
  let admin, pool, app, dbName;
  const eventId = randomUUID();
  const staffId = randomUUID();
  const fx = { startsAt: Date.now() + 3_600_000, ticketDown: false, admitCalls: 0, answer: null };
  const clients = {
    getEvent: async () => ({ status: 200, json: { startsAt: new Date(fx.startsAt).toISOString() } }),
    admit: async (b) => {
      fx.admitCalls++;
      if (fx.ticketDown) throw new Error("down");
      return { status: 200, json: fx.answer ?? { result: "admitted", ticketId: randomUUID(), holderName: "Asha K.", seatLabel: "Stalls D-7", tierId: randomUUID(), usedAt: new Date().toISOString(), usedGate: b.gateId } };
    },
    ticketCounts: async () => ({ status: 200, json: { issued: 10, used: 3 } }),
  };

  before(async () => {
    const { buildApp } = await import("../src/app.js");
    const { createPool } = await import("../src/db.js");
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `gate_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = await createPool(url.toString());
    app = await buildApp({ pool, clients, logger: silent });
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const body = (over = {}) => ({ scanId: randomUUID(), eventId, gateId: "G1", token: "t".repeat(55), scannedAt: new Date().toISOString(), ...over });
  const post = (payload, headers = { "x-user-id": staffId, "x-user-role": "staff" }) => app.inject({ method: "POST", url: "/gate/scans", headers, payload });
  const rows = async (scanId) => (await pool.query("SELECT * FROM scans WHERE scan_id = $1", [scanId])).rows;

  test("an admitted scan returns the holder and is stored, without the QR token", async () => {
    const b = body();
    const r = await post(b);
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().result, r.json().holderName, r.json().seatLabel], ["admitted", "Asha K.", "Stalls D-7"]);
    const [stored] = await rows(b.scanId);
    assert.equal(stored.ticket_id !== null, true);
    assert.equal(JSON.stringify(stored).includes(b.token), false);
  });

  test("the same scanId sent three times (two at once): one row and the same stored answer every time", async () => {
    const b = body();
    const before = fx.admitCalls;
    const [a, c] = await Promise.all([post(b), post(b)]);
    const again = await post(b);
    assert.equal((await rows(b.scanId)).length, 1);
    for (const r of [a, c, again]) assert.equal(r.statusCode, 200);
    assert.deepEqual([a.json().usedAt, c.json().usedAt], [again.json().usedAt, again.json().usedAt]);
    assert.ok(fx.admitCalls - before <= 2); // racing first attempts may both ask; the stored answer wins
    assert.equal(again.json().result, "admitted");
  });

  test("the same scanId with a different event is refused", async () => {
    const b = body();
    await post(b);
    assert.equal((await post({ ...b, eventId: randomUUID() })).statusCode, 422);
  });

  test("the same scanId with a different QR, gate or time is refused, never answered with the first scan's result", async () => {
    const b = body();
    await post(b);
    for (const change of [{ token: "u".repeat(55) }, { gateId: "G2" }, { scannedAt: new Date(Date.now() + 1000).toISOString() }]) {
      assert.equal((await post({ ...b, ...change })).statusCode, 422, JSON.stringify(Object.keys(change)));
    }
    assert.equal((await post(b)).statusCode, 200); // the genuine retry still works
    const stored = (await rows(b.scanId))[0];
    assert.equal(stored.request_hash.length, 64);
    assert.equal(JSON.stringify(stored).includes(b.token), false);
  });

  test("an unreadable event start time fails closed instead of counting as open", async () => {
    const real = clients.getEvent;
    clients.getEvent = async () => ({ status: 200, json: { startsAt: "not a date" } });
    const r = await post(body({ eventId: randomUUID() }));
    clients.getEvent = real;
    assert.equal(r.statusCode, 503);
  });

  test("only staff may scan: attendees and anonymous callers are refused and nothing is recorded", async () => {
    const b = body();
    assert.equal((await post(b, { "x-user-id": staffId, "x-user-role": "attendee" })).statusCode, 403);
    assert.equal((await post(b, { "x-user-id": staffId, "x-user-role": "admin" })).statusCode, 403);
    assert.equal((await post(b, {})).statusCode, 401);
    assert.equal((await rows(b.scanId)).length, 0);
  });

  test("ticket-service down: 503, nothing stored, and the same scanId works once it is back", async () => {
    const b = body();
    fx.ticketDown = true;
    const r = await post(b);
    fx.ticketDown = false;
    assert.equal(r.statusCode, 503);
    assert.equal((await rows(b.scanId)).length, 0);
    assert.equal((await post(b)).json().result, "admitted");
  });

  test("a rejection is a normal 200 answer, stored with its reason", async () => {
    fx.answer = { result: "rejected", reason: "already_used", holderName: "Asha K.", usedAt: new Date().toISOString(), usedGate: "G9" };
    const b = body();
    const r = await post(b);
    fx.answer = null;
    assert.deepEqual([r.statusCode, r.json().result, r.json().reason, r.json().usedGate], [200, "rejected", "already_used", "G9"]);
    assert.equal((await rows(b.scanId))[0].reason, "already_used");
  });

  test("outside the window (more than 6 h before, or 12 h after the start) the event is not open", async () => {
    const calls = fx.admitCalls;
    fx.startsAt = Date.now() + 7 * 3_600_000;
    const early = await post(body({ eventId: randomUUID() }));
    fx.startsAt = Date.now() - 13 * 3_600_000;
    const late = await post(body({ eventId: randomUUID() }));
    fx.startsAt = Date.now() + 3_600_000;
    assert.deepEqual([early.json().reason, late.json().reason], ["event_not_open", "event_not_open"]);
    assert.equal(fx.admitCalls, calls); // the ticket service was never asked
  });

  test("bad input is a 400, and the live stats count admitted and rejected scans", async () => {
    assert.equal((await post({ scanId: "nope" })).statusCode, 400);
    const s = await app.inject({ method: "GET", url: `/gate/events/${eventId}/stats`, headers: { "x-user-id": staffId, "x-user-role": "staff" } });
    const j = s.json();
    assert.ok(j.admitted >= 3 && j.rejected >= 1);
    assert.deepEqual([j.issued, j.used], [10, 3]);
    assert.equal((await app.inject({ method: "GET", url: `/gate/events/${eventId}/stats`, headers: { "x-user-id": staffId, "x-user-role": "attendee" } })).statusCode, 403);
  });
});
