import { createHmac, timingSafeEqual } from "node:crypto";

// Admission tokens: proof that queue-service let this user in for this event. Signed with a secret shared only by
// queue-service (signs) and booking-service (verifies), so booking needs no call to queue-service per order.
//   token = "v1." + base64url(JSON {u: userId, e: eventId, x: expiresAtMs}) + "." + hex(HMAC-SHA256(secret, "v1." + payload))
// The same (user, event, expiry) always gives the same token, so the queue can hand it out again after a page reload
// without storing it.

const b64 = (s) => Buffer.from(s).toString("base64url");
const mac = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

/** @param {string} secret @param {{ userId: string, eventId: string, expiresAtMs: number }} t */
export function signAdmission(secret, { userId, eventId, expiresAtMs }) {
  const body = `v1.${b64(JSON.stringify({ u: userId, e: eventId, x: expiresAtMs }))}`;
  return `${body}.${mac(secret, body)}`;
}

/**
 * Checks the signature first (so a forged token learns nothing), then expiry, then that it was issued to this user for
 * this event.
 * @param {string} secret
 * @param {unknown} token
 * @param {{ userId: string, eventId: string, now?: number }} expected
 * @returns {{ ok: true, expiresAtMs: number } | { ok: false, reason: "invalid" | "expired" | "wrong_user" | "wrong_event" }}
 */
export function verifyAdmission(secret, token, { userId, eventId, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 400) return { ok: false, reason: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "invalid" };
  const body = `${parts[0]}.${parts[1]}`;
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(mac(secret, body));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "invalid" };
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof p?.u !== "string" || typeof p?.e !== "string" || !Number.isFinite(p?.x)) return { ok: false, reason: "invalid" };
  if (p.x <= now) return { ok: false, reason: "expired" };
  if (p.u.toLowerCase() !== String(userId).toLowerCase()) return { ok: false, reason: "wrong_user" };
  if (p.e.toLowerCase() !== String(eventId).toLowerCase()) return { ok: false, reason: "wrong_event" };
  return { ok: true, expiresAtMs: p.x };
}
