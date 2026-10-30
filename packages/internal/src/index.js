import { createHash, timingSafeEqual } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digest = (s) => createHash("sha256").update(s).digest();

/**
 * Fastify preHandler for /internal/* routes: requires x-internal-token to equal the shared secret.
 * The gateway never forwards these paths, so this is the second layer.
 * @param {string} token
 */
export function requireInternalToken(token) {
  const expected = digest(token);
  return async (req, reply) => {
    const got = req.headers["x-internal-token"];
    if (typeof got !== "string" || !timingSafeEqual(digest(got), expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

export class InternalHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = "InternalHttpError";
  }
}

const RETRY_STATUS = new Set([502, 503, 504]);

/**
 * Service-to-service call: timeout, 3 attempts with jittered backoff (200/400/800 ms), request id forwarded.
 * Retries only network errors and 502/503/504, never 4xx. Resolves with the final { status, json };
 * throws InternalHttpError if no attempt got an HTTP answer.
 * @param {string} url
 * @param {{ method?: string, body?: unknown, token?: string, requestId?: string, headers?: Record<string,string>, timeoutMs?: number, attempts?: number }} [opts]
 * @returns {Promise<{ status: number, json: any }>}
 */
export async function internalFetch(url, { method = "GET", body, token, requestId, headers = {}, timeoutMs = 2000, attempts = 3 } = {}) {
  let last = new InternalHttpError("no attempt made");
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(200 * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { "x-internal-token": token } : {}),
          ...(requestId ? { "x-request-id": requestId } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => ({}));
      if (RETRY_STATUS.has(res.status) && i < attempts - 1) {
        last = new InternalHttpError(`upstream ${res.status}`);
        continue;
      }
      return { status: res.status, json };
    } catch (err) {
      last = new InternalHttpError(err?.name === "TimeoutError" ? "timeout" : "network error");
    }
  }
  throw last;
}
