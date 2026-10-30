import pino from "pino";

// Never let secrets or personal identifiers reach the logs.
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.otp",
  "*.aadhaar",
  "*.uid",
  "*.txnId",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.card",
];

/**
 * @param {string} service service name added to every log line
 * @returns {import("pino").Logger}
 */
export function createLogger(service) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT, censor: "[redacted]" },
  });
}

export const REQUEST_ID_HEADER = "x-request-id";
