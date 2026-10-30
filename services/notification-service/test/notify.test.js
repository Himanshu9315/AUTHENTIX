import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PermanentError } from "@authentix/events";

const adminUrl = process.env.TEST_PG_URL;
const skip = adminUrl ? false : "TEST_PG_URL not set (needs the dev Postgres from docker compose)";
const WEB = "http://localhost:8080";

describe("notification-service", { skip }, () => {
  let admin, pool, dbName, notify, app, EMAIL, INBOX, escapeHtml;
  const logs = [];
  // Records every log line, so tests can prove secrets never reach the logs. (Fastify needs `child` and `level` too.)
  const logger = Object.fromEntries(["info", "warn", "error", "debug", "fatal", "trace"].map((l) => [l, (...a) => logs.push(JSON.stringify(a))]));
  logger.child = () => logger;
  logger.level = "info";
  const fx = { smtpFail: 0, mails: [], contacts: new Map(), authDown: false };
  const sink = { sendMail: async (m) => { if (fx.smtpFail > 0) { fx.smtpFail--; throw new Error(`boom for ${m.to}`); } fx.mails.push(m); } };
  const ev = { id: randomUUID(), slug: "x", title: "Blue Lotus <script>alert(1)</script>", venue: { name: "Harbour Hall", city: "Mumbai" }, startsAt: new Date(Date.now() + 864e5).toISOString() };
  const clients = {
    getContact: async (id) => { if (fx.authDown) throw new Error("down"); const c = fx.contacts.get(id); return c ? { status: 200, json: c } : { status: 404, json: {} }; },
    getEvent: async () => ({ status: 200, json: ev }),
  };
  const person = (over = {}) => { const id = randomUUID(); fx.contacts.set(id, { email: `p${id.slice(0, 6)}@example.test`, firstName: "Asha", displayName: "Asha K.", emailVerified: true, ...over }); return id; };

  before(async () => {
    const { createPool } = await import("../src/db.js");
    const { createNotifier } = await import("../src/deliver.js");
    const { buildApp } = await import("../src/app.js");
    ({ EMAIL, INBOX, escapeHtml } = await import("../src/templates.js"));
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `notif_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = await createPool(url.toString());
    notify = createNotifier({ pool, clients, sink, logger, config: { webBaseUrl: WEB, mailFrom: "Authentix <no-reply@authentix.test>", claimStaleSeconds: 120 } });
    app = await buildApp({ pool, logger });
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const orderEvent = (userId, over = {}) => ({ id: randomUUID(), type: "order.confirmed", occurredAt: new Date().toISOString(), payload: { orderId: randomUUID(), userId, eventId: ev.id, items: [{ tierId: randomUUID(), seatId: randomUUID(), seatLabel: "Stalls D-7", quantity: 1, unitPriceInr: 3299 }], totalInr: 3299, confirmedAt: new Date().toISOString(), ...over } });
  const sent = () => fx.mails.length;
  const inboxCount = async (u) => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [u])).rows[0].n;

  test("the same order.confirmed handled twice, and twice at once, gives one email and one inbox entry", async () => {
    const u = person();
    const e = orderEvent(u);
    const before = sent();
    await notify(e);
    await notify(structuredClone(e));
    await Promise.allSettled([notify(structuredClone(e)), notify(structuredClone(e))]);
    assert.equal(sent() - before, 1);
    assert.equal(await inboxCount(u), 1);
    assert.match(fx.mails.at(-1).subject, /confirmed/);
  });

  test("when the mail server fails the claim is released, and the retry sends exactly one email", async () => {
    const u = person();
    const e = orderEvent(u);
    const before = sent();
    fx.smtpFail = 1;
    await assert.rejects(notify(e), (err) => err.message === "smtp send failed" && !err.message.includes("@")); // the recipient never leaks into the error
    assert.equal(sent(), before);
    const row = (await pool.query("SELECT status, claimed_at FROM deliveries WHERE user_id = $1", [u])).rows[0];
    assert.deepEqual([row.status, row.claimed_at], ["sending", null]);
    await notify(e);
    await notify(e);
    assert.equal(sent() - before, 1);
  });

  test("a stale claim (a crashed worker) is taken over once; a fresh claim makes the handler wait", async () => {
    const u = person();
    const e = orderEvent(u);
    const key = `${e.id}:${u}:email:order_confirmed`;
    await pool.query("INSERT INTO deliveries (dedupe_key, event_id, user_id, channel, template, status, attempts, claimed_at) VALUES ($1,$2,$3,'email','order_confirmed','sending',1, now())", [key, e.id, u]);
    await assert.rejects(notify(e), /in progress/); // someone else is mid-send: retry later
    const before = sent();
    await pool.query("UPDATE deliveries SET claimed_at = now() - interval '3 minutes' WHERE dedupe_key = $1", [key]);
    await notify(e);
    await notify(e);
    assert.equal(sent() - before, 1);
  });

  test("verification email: the link keeps the token in the #fragment, and the token is in no log line and no database row", async () => {
    const u = person({ emailVerified: false });
    const token = "tok_" + randomUUID().replaceAll("-", "") + "ZZ";
    const email = `new${u.slice(0, 6)}@example.test`;
    logs.length = 0;
    const e = { id: randomUUID(), type: "user.email_verification_requested", payload: { userId: u, email, name: "Asha Kulkarni", token } };
    await notify(e);
    const mail = fx.mails.at(-1);
    assert.equal(mail.to, email);
    assert.ok(mail.text.includes(`${WEB}/verify-email#token=${token}`) && mail.html.includes(`${WEB}/verify-email#token=${token}`));
    assert.equal(mail.text.includes("?token="), false);
    assert.equal(logs.join("\n").includes(token), false);
    assert.equal(logs.join("\n").includes(email), false);
    const dump = JSON.stringify((await pool.query("SELECT * FROM deliveries WHERE user_id = $1", [u])).rows) + JSON.stringify((await pool.query("SELECT * FROM notifications")).rows);
    assert.equal(dump.includes(token) || dump.includes(email), false);
  });

  test("a verification email for someone who already confirmed is suppressed and nothing is sent", async () => {
    const u = person({ emailVerified: true });
    const before = sent();
    await notify({ id: randomUUID(), type: "user.email_verification_requested", payload: { userId: u, email: "x@example.test", name: "Asha K", token: "t".repeat(30) } });
    assert.equal(sent(), before);
    assert.equal((await pool.query("SELECT status FROM deliveries WHERE user_id = $1", [u])).rows[0].status, "suppressed");
  });

  test("templates leak nothing they weren't given, and escape markup in event titles", () => {
    const spike = { ticketId: randomUUID(), qr: "QRTOKEN".repeat(8), holderKey: "k".repeat(40), fullName: "Asha Kulkarni", surname: "Kulkarni", aadhaar: "100000000001" };
    const common = { firstName: "Asha", event: ev, other: "Ravi M.", webBaseUrl: WEB, link: `${WEB}/verify-email#token=abc`, reason: "sold_out", order: { ref: "abcd1234", totalInr: 3299, items: [{ seatLabel: "Stalls D-7", quantity: 1 }] }, ...spike };
    for (const [name, render] of Object.entries(EMAIL)) {
      const m = render(common);
      for (const secret of Object.values(spike)) assert.equal(m.text.includes(secret) || m.html.includes(secret) || m.subject.includes(secret), false, `${name} leaked ${secret.slice(0, 6)}`);
      assert.equal(m.html.includes("<script>"), false, `${name} html must escape markup`);
      assert.ok(m.html.includes('lang="en"') && m.text.length > 20);
    }
    for (const [name, render] of Object.entries(INBOX)) assert.ok(!JSON.stringify(render(common)).includes("QRTOKEN"), name);
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("an unknown recipient is a permanent error (parked), an unreachable auth-service is retryable, and a bad payload is permanent", async () => {
    await assert.rejects(notify(orderEvent(randomUUID())), PermanentError);
    const u = person();
    fx.authDown = true;
    await assert.rejects(notify(orderEvent(u)), (err) => !(err instanceof PermanentError));
    fx.authDown = false;
    // a 503 ANSWER (not just a thrown error) is also retryable
    const real = clients.getContact;
    clients.getContact = async () => ({ status: 503, json: {} });
    await assert.rejects(notify(orderEvent(u)), (err) => !(err instanceof PermanentError) && /503/.test(err.message));
    clients.getContact = real;
    assert.equal(sent(), fx.mails.length);
    await assert.rejects(notify({ id: randomUUID(), type: "order.confirmed", payload: { nope: 1 } }), PermanentError);
    await notify({ id: randomUUID(), type: "user.registered", payload: {} }); // not an event we notify about: quietly ignored
  });

  test("a transfer tells both people, naming the other as first name plus initial", async () => {
    const to = person({ displayName: "Ravi M.", firstName: "Ravi" });
    const from = person({ displayName: "Asha K.", firstName: "Asha" });
    const before = sent();
    await notify({ id: randomUUID(), type: "ticket.transferred", payload: { transferId: randomUUID(), ticketId: randomUUID(), eventId: ev.id, fromUserId: from, toUserId: to, newVersion: 2, transferredAt: new Date().toISOString() } });
    assert.equal(sent() - before, 2);
    const [a, b] = fx.mails.slice(-2);
    assert.ok([a, b].some((m) => m.subject.includes("received") && m.text.includes("Asha K.")));
    assert.ok([a, b].some((m) => m.subject.includes("transferred") && m.text.includes("Ravi M.")));
    assert.equal((await inboxCount(to)) + (await inboxCount(from)), 2);
  });

  test("no more than 20 emails an hour per person: the rest are suppressed, not sent", async () => {
    const u = person();
    const before = sent();
    for (let i = 0; i < 23; i++) await notify(orderEvent(u));
    assert.equal(sent() - before, 20);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE user_id = $1 AND status = 'suppressed'", [u])).rows[0].n, 3);
    assert.equal(await inboxCount(u), 23); // the inbox still gets every one
  });

  test("the hourly cap never blocks the verification email", async () => {
    const u = person({ emailVerified: false });
    for (let i = 0; i < 22; i++) await notify(orderEvent(u)); // reach and pass the cap
    const before = sent();
    await notify({ id: randomUUID(), type: "user.email_verification_requested", payload: { userId: u, email: "v@example.test", name: "Asha K", token: "t".repeat(30) } });
    assert.equal(sent() - before, 1);
  });

  test("the inbox is private: another user's notification is 'not found', listing is scoped, unread count and read-all work", async () => {
    const a = person();
    const b = person();
    for (let i = 0; i < 3; i++) await notify(orderEvent(a));
    await notify(orderEvent(b));
    const h = (u) => ({ "x-user-id": u });
    const listA = (await app.inject({ method: "GET", url: "/notifications", headers: h(a) })).json();
    assert.equal(listA.items.length, 3);
    assert.deepEqual(Object.keys(listA.items[0]).sort(), ["body", "createdAt", "id", "kind", "link", "readAt", "title"]);
    assert.equal((await app.inject({ method: "POST", url: `/notifications/${listA.items[0].id}/read`, headers: h(b) })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/notifications/${randomUUID()}/read`, headers: h(a) })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/notifications/unread-count", headers: h(a) })).json().unread, 3);
    assert.equal((await app.inject({ method: "POST", url: `/notifications/${listA.items[0].id}/read`, headers: { ...h(a), "content-type": "application/json" } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/notifications/unread-count", headers: h(a) })).json().unread, 2);
    assert.equal((await app.inject({ method: "POST", url: "/notifications/read-all", headers: h(b) })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/notifications/unread-count", headers: h(a) })).json().unread, 2); // b's read-all didn't touch a's
    assert.equal((await app.inject({ method: "GET", url: "/notifications" })).statusCode, 401);
  });

  test("paging by cursor returns every notification once, newest first", async () => {
    const u = person();
    for (let i = 0; i < 7; i++) await pool.query("INSERT INTO notifications (dedupe_key, user_id, kind, title, body) VALUES ($1,$2,'x',$3,'b')", [randomUUID(), u, `n${i}`]);
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const r = (await app.inject({ method: "GET", url: `/notifications?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`, headers: { "x-user-id": u } })).json();
      seen.push(...r.items.map((i) => i.title));
      cursor = r.nextBefore;
      if (!cursor) break;
    }
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    for (const bad of ["garbage", "2020-01-01T00:00:00.000000Z~------------------------------------", "2020-99-99T00:00:00.000000Z~3f2b8c1e-0000-4000-8000-000000000002", "2020-01-01T00:00:00.000000Z~not-a-uuid"]) {
      assert.equal((await app.inject({ method: "GET", url: `/notifications?before=${encodeURIComponent(bad)}`, headers: { "x-user-id": u } })).statusCode, 400, bad);
    }
  });
});
