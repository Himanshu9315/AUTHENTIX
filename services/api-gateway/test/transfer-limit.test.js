import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { buildApp } from "../src/app.js";

const SECRET = "x".repeat(40);
const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, level: "silent" };
const token = (sub, role = "attendee") => jwt.sign({ role }, SECRET, { subject: sub, algorithm: "HS256", issuer: "authentix", audience: "authentix-api", expiresIn: 60 });

describe("gateway: transfer rate limit and role rules", () => {
  let upstream, app, port;
  before(async () => {
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, method: req.method, path: req.url, received: raw, length: req.headers["content-length"] ?? null }));
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    port = upstream.address().port;
    const base = `http://127.0.0.1:${port}`;
    app = await buildApp({ logger: silent, config: { jwtSecret: SECRET, corsOrigins: [], routes: { tickets: base, gate: base, queue: base }, transferLimitPerHour: 3 } });
  });
  after(async () => {
    await app.close();
    upstream.close();
  });

  const transfer = (userId) =>
    app.inject({ method: "POST", url: `/api/tickets/${randomUUID()}/transfer`, headers: { authorization: `Bearer ${token(userId)}`, "content-type": "application/json" }, payload: "{}" });

  test("each user gets 3 transfers an hour; the 4th is 429; another user is unaffected", async () => {
    const a = randomUUID();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await transfer(a)).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await transfer(randomUUID())).statusCode, 200);
  });

  test("other ticket routes are not limited", async () => {
    const u = randomUUID();
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "GET", url: "/api/tickets", headers: { authorization: `Bearer ${token(u)}` } });
      assert.equal(r.statusCode, 200); // the bare /api/tickets (no trailing segment) is routed too
    }
  });

  test("waiting-room polling has its own, larger allowance and doesn't use up the normal one", async () => {
    // A separate gateway with a tiny normal limit, so the difference between the two buckets is easy to see.
    const small = await buildApp({ logger: silent, config: { jwtSecret: SECRET, corsOrigins: [], routes: { tickets: `http://127.0.0.1:${port}`, queue: `http://127.0.0.1:${port}` }, rateLimitMax: 3, queueRateLimitMax: 50 } });
    const u = randomUUID();
    const get = (url) => small.inject({ method: "GET", url, headers: { authorization: `Bearer ${token(u)}` } });
    for (let i = 0; i < 20; i++) assert.equal((await get("/api/queue/events/x/me")).statusCode, 200); // far past the normal limit of 3
    const normal = [];
    for (let i = 0; i < 5; i++) normal.push((await get("/api/tickets")).statusCode);
    assert.deepEqual(normal, [200, 200, 200, 429, 429]); // the normal bucket was untouched by the polling, then limits as set
    await small.close();
  });

  test("an empty body with a JSON content-type is fine, and a real body reaches the service byte for byte", async () => {
    const h = { authorization: `Bearer ${token(randomUUID())}`, "content-type": "application/json" };
    const del = await app.inject({ method: "DELETE", url: "/api/tickets/x", headers: h });
    assert.deepEqual([del.statusCode, del.json().received], [200, ""]);
    const empty = await app.inject({ method: "POST", url: "/api/tickets/x/note", headers: h });
    assert.deepEqual([empty.statusCode, empty.json().received], [200, ""]);
    const exact = '{ "a" :  1,"b":"é" }'; // odd spacing and non-ASCII must survive untouched
    const full = await app.inject({ method: "POST", url: "/api/tickets/x/note", headers: h, payload: exact });
    assert.deepEqual([full.statusCode, full.json().received, full.json().length], [200, exact, String(Buffer.byteLength(exact))]);
  });

  test("only staff reach /api/gate/*", async () => {
    const as = (role) => app.inject({ method: "GET", url: "/api/gate/events/x/stats", headers: { authorization: `Bearer ${token(randomUUID(), role)}` } });
    assert.equal((await as("attendee")).statusCode, 403);
    assert.equal((await as("organiser")).statusCode, 403);
    assert.equal((await as("staff")).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/gate/events/x/stats" })).statusCode, 401);
  });
});
