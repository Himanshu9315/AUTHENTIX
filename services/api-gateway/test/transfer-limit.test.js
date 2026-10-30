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
    upstream = createServer((req, res) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ ok: true, path: req.url }))));
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    port = upstream.address().port;
    const base = `http://127.0.0.1:${port}`;
    app = await buildApp({ logger: silent, config: { jwtSecret: SECRET, corsOrigins: [], routes: { tickets: base, gate: base }, transferLimitPerHour: 3 } });
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

  test("only staff reach /api/gate/*", async () => {
    const as = (role) => app.inject({ method: "GET", url: "/api/gate/events/x/stats", headers: { authorization: `Bearer ${token(randomUUID(), role)}` } });
    assert.equal((await as("attendee")).statusCode, 403);
    assert.equal((await as("organiser")).statusCode, 403);
    assert.equal((await as("staff")).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/gate/events/x/stats" })).statusCode, 401);
  });
});
