import { createHmac } from "node:crypto";

/**
 * Keyed hash used for "one Aadhaar, one account" and per-event caps. Deliberately not salted per user:
 * the same number must always produce the same hash. The server-side secret is what protects the
 * small 12-digit space from offline guessing if the table leaks.
 * @param {string} secret
 * @param {string} aadhaar 12 digits
 */
export const hashAadhaar = (secret, aadhaar) => createHmac("sha256", secret).update(aadhaar).digest("hex");

/** @param {string} aadhaar 12 digits */
export const last4 = (aadhaar) => aadhaar.slice(-4);

/**
 * Per-Aadhaar key handed to booking for the per-event ticket cap. Derived from the stored hash with a
 * different label, so the uniqueness hash itself never leaves this service.
 * @param {string} secret
 * @param {string} aadhaarHash
 */
export const holderKey = (secret, aadhaarHash) => createHmac("sha256", secret).update(`holder:v1:${aadhaarHash}`).digest("hex");
