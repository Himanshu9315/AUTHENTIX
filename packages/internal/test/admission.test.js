import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signAdmission, verifyAdmission } from "../src/admission.js";

const secret = "s".repeat(40);
const user = randomUUID();
const event = randomUUID();
const now = 1_800_000_000_000;
const good = () => signAdmission(secret, { userId: user, eventId: event, expiresAtMs: now + 600_000 });

describe("admission tokens", () => {
  test("a token verifies for the user and event it was issued for, and is the same every time", () => {
    assert.deepEqual(verifyAdmission(secret, good(), { userId: user, eventId: event, now }), { ok: true, expiresAtMs: now + 600_000 });
    assert.equal(good(), good());
  });

  test("it is refused for another user, another event, or after it expires", () => {
    assert.equal(verifyAdmission(secret, good(), { userId: randomUUID(), eventId: event, now }).reason, "wrong_user");
    assert.equal(verifyAdmission(secret, good(), { userId: user, eventId: randomUUID(), now }).reason, "wrong_event");
    assert.equal(verifyAdmission(secret, good(), { userId: user, eventId: event, now: now + 600_000 }).reason, "expired");
    assert.equal(verifyAdmission(secret, good(), { userId: user, eventId: event, now: now + 599_999 }).ok, true);
  });

  test("a different secret, a tampered payload or signature, and junk are all invalid, and expiry is checked only after the signature", () => {
    const [v, payload, sig] = good().split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ u: user, e: event, x: now + 99_999_999 })).toString("base64url");
    const cases = [
      signAdmission("other".repeat(10), { userId: user, eventId: event, expiresAtMs: now + 600_000 }),
      `${v}.${forgedPayload}.${sig}`,
      `${v}.${payload}.${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`,
      `${v}.${payload}`, "", "v1..", "v2.a.b", "x".repeat(500), null, undefined, 42, {},
    ];
    for (const c of cases) assert.equal(verifyAdmission(secret, c, { userId: user, eventId: event, now }).reason, "invalid", String(c).slice(0, 30));
    // an expired token that also has a bad signature says "invalid", not "expired"
    const expiredForged = signAdmission("other".repeat(10), { userId: user, eventId: event, expiresAtMs: now - 1 });
    assert.equal(verifyAdmission(secret, expiredForged, { userId: user, eventId: event, now }).reason, "invalid");
  });

  test("ids compare case-insensitively", () => {
    assert.equal(verifyAdmission(secret, good(), { userId: user.toUpperCase(), eventId: event.toUpperCase(), now }).ok, true);
  });
});
