import { createHmac, timingSafeEqual } from "node:crypto";

// Rotating QR tokens. Pure functions: no I/O, so they are easy to test.
//
// token = base64url( 0x01 | ticketId(16) | version(u32 BE) | step(u32 BE) | mac(16) )   -> 41 bytes, 55 characters
// mac   = first 16 bytes of HMAC-SHA256(ticketSecret, the first 25 bytes)
// step  = floor(unixMs / 30000)
// ticketSecret = HMAC-SHA256(QR_MASTER_KEY, "authentix:qr:v1:" + ticketId + ":" + version), derived, never stored.
// A transfer bumps `version`, which changes the secret, so every older token dies the moment the transfer commits.

export const STEP_MS = 30_000;
const FORMAT = 0x01;
const BODY_LEN = 25;
const TOKEN_LEN = 41;

export const stepAt = (ms) => Math.floor(ms / STEP_MS);

/** @param {Buffer} masterKey @param {string} ticketId @param {number} version */
export const deriveSecret = (masterKey, ticketId, version) =>
  createHmac("sha256", masterKey).update(`authentix:qr:v1:${ticketId}:${version}`).digest();

const uuidToBytes = (id) => Buffer.from(id.replaceAll("-", ""), "hex");
const bytesToUuid = (b) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** @returns {string} the QR token for a ticket version at one 30-second step */
export function encodeToken(masterKey, ticketId, version, step) {
  const body = Buffer.alloc(BODY_LEN);
  body[0] = FORMAT;
  uuidToBytes(ticketId).copy(body, 1);
  body.writeUInt32BE(version, 17);
  body.writeUInt32BE(step, 21);
  const mac = createHmac("sha256", deriveSecret(masterKey, ticketId, version)).update(body).digest().subarray(0, 16);
  return Buffer.concat([body, mac]).toString("base64url");
}

/**
 * Checks a scanned token. The signature is verified before anything else, so a forged token reveals nothing about
 * which tickets exist. Accepts the current 30-second step and one either side (about 90 s worst case): one back
 * covers a code shown just before a boundary plus scan delay, one forward covers a phone clock slightly ahead.
 * @param {Buffer} masterKey
 * @param {string} token
 * @param {number} atMs when the QR was scanned
 * @returns {{ ok: true, ticketId: string, version: number, step: number } | { ok: false, reason: "invalid_qr" | "qr_expired" }}
 */
export function verifyToken(masterKey, token, atMs) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{55}$/.test(token)) return { ok: false, reason: "invalid_qr" };
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== TOKEN_LEN || raw[0] !== FORMAT) return { ok: false, reason: "invalid_qr" };
  const ticketId = bytesToUuid(raw.subarray(1, 17));
  const version = raw.readUInt32BE(17);
  const step = raw.readUInt32BE(21);
  const expected = createHmac("sha256", deriveSecret(masterKey, ticketId, version)).update(raw.subarray(0, BODY_LEN)).digest().subarray(0, 16);
  if (!timingSafeEqual(expected, raw.subarray(BODY_LEN))) return { ok: false, reason: "invalid_qr" };
  if (Math.abs(step - stepAt(atMs)) > 1) return { ok: false, reason: "qr_expired" };
  return { ok: true, ticketId, version, step };
}
