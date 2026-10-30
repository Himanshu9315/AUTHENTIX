import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { STEP_MS, deriveSecret, encodeToken, stepAt, verifyToken } from "../src/qr.js";

const key = randomBytes(32);
const id = randomUUID();
const T = 1_800_000_000_000; // a fixed "now"
const step = stepAt(T);

describe("rotating QR tokens", () => {
  test("a token is 41 bytes / 55 characters and the step changes exactly every 30 seconds", () => {
    const t = encodeToken(key, id, 1, step);
    assert.equal(t.length, 55);
    assert.equal(Buffer.from(t, "base64url").length, 41);
    assert.equal(stepAt(29_999), 0);
    assert.equal(stepAt(30_000), 1);
    assert.equal(STEP_MS, 30_000);
  });

  test("the same ticket, version and step always give the same token; any change gives a different one", () => {
    assert.equal(encodeToken(key, id, 1, step), encodeToken(key, id, 1, step));
    assert.notEqual(encodeToken(key, id, 1, step), encodeToken(key, id, 1, step + 1));
    assert.notEqual(encodeToken(key, id, 1, step), encodeToken(key, id, 2, step));
    assert.notEqual(encodeToken(key, id, 1, step), encodeToken(key, randomUUID(), 1, step));
    assert.notDeepEqual(deriveSecret(key, id, 1), deriveSecret(key, id, 2));
  });

  test("accepts the current step and one either side, rejects two away (screenshots expire)", () => {
    for (const d of [-1, 0, 1]) assert.equal(verifyToken(key, encodeToken(key, id, 1, step + d), T).ok, true, `step ${d}`);
    for (const d of [-2, 2, -50]) {
      const r = verifyToken(key, encodeToken(key, id, 1, step + d), T);
      assert.deepEqual([r.ok, r.reason], [false, "qr_expired"], `step ${d}`);
    }
  });

  test("a token captured before a boundary still works just after it, then stops", () => {
    const t = encodeToken(key, id, 1, step);
    const boundary = (step + 1) * STEP_MS;
    assert.equal(verifyToken(key, t, boundary - 1).ok, true);
    assert.equal(verifyToken(key, t, boundary + 1).ok, true); // now one step behind: still accepted
    const later = verifyToken(key, t, boundary + STEP_MS + 1); // now two steps behind: a screenshot has expired
    assert.deepEqual([later.ok, later.reason], [false, "qr_expired"]);
  });

  test("tampering with any field is invalid_qr, and the signature is checked before expiry", () => {
    const good = Buffer.from(encodeToken(key, id, 1, step), "base64url");
    for (const [name, at] of [["format byte", 0], ["ticket id", 5], ["version", 20], ["step", 24], ["mac", 30], ["last mac byte", 40]]) {
      const bad = Buffer.from(good);
      bad[at] ^= 0x01;
      assert.equal(verifyToken(key, bad.toString("base64url"), T).reason, "invalid_qr", name);
    }
    // an old step with a forged MAC must say invalid_qr, not qr_expired, so forgers learn nothing
    assert.equal(verifyToken(key, encodeToken(key, id, 1, step - 10), T).reason, "qr_expired"); // genuine but old
    const forgedOld = Buffer.from(encodeToken(key, id, 1, step - 10), "base64url");
    forgedOld[30] ^= 0x01;
    assert.equal(verifyToken(key, forgedOld.toString("base64url"), T).reason, "invalid_qr");
  });

  test("a token for version 1 cannot be passed off as version 2 (a transferred ticket's old QR is dead)", () => {
    const raw = Buffer.from(encodeToken(key, id, 1, step), "base64url");
    raw.writeUInt32BE(2, 17);
    assert.equal(verifyToken(key, raw.toString("base64url"), T).reason, "invalid_qr");
    assert.equal(verifyToken(key, encodeToken(key, id, 2, step), T).version, 2);
  });

  test("a different master key cannot validate the token", () => {
    assert.equal(verifyToken(randomBytes(32), encodeToken(key, id, 1, step), T).reason, "invalid_qr");
  });

  test("malformed input is invalid_qr, never an exception", () => {
    for (const bad of ["", "abc", "!".repeat(55), "A".repeat(54), "A".repeat(56), null, undefined, 42, {}, "A".repeat(55)]) {
      assert.equal(verifyToken(key, bad, T).reason, "invalid_qr", String(bad));
    }
    const wrongFormat = Buffer.from(encodeToken(key, id, 1, step), "base64url");
    wrongFormat[0] = 0x02;
    assert.equal(verifyToken(key, wrongFormat.toString("base64url"), T).reason, "invalid_qr");
  });
});
