const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UidaiError extends Error {
  /** @param {number} status 0 for network failures and timeouts @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Client for (mock) UIDAI with a timeout and retries on network errors and 5xx.
 * 4xx responses are answers, not failures, so they are never retried.
 * @param {{ baseUrl: string, timeoutMs?: number, retries?: number, backoffMs?: number }} opts
 */
export function createUidaiClient({ baseUrl, timeoutMs = 6000, retries = 2, backoffMs = 200 }) {
  async function call(path, body, requestId) {
    let last = new UidaiError(0, "uidai_unavailable");
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      try {
        const res = await fetch(baseUrl + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...(requestId ? { "x-request-id": requestId } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        last = new UidaiError(res.status, json.error ?? "uidai_error");
        if (res.status < 500) throw last;
      } catch (err) {
        if (err instanceof UidaiError && err.status < 500 && err.status !== 0) throw err;
        last = err instanceof UidaiError ? err : new UidaiError(0, "uidai_unavailable");
      }
    }
    throw last;
  }

  return {
    /** @returns {Promise<{ txnId: string }>} */
    sendOtp: (aadhaar, requestId) => call("/uidai/otp/send", { uid: aadhaar }, requestId),
    /** @returns {Promise<{ verified: true }>} */
    verifyOtp: (txnId, otp, requestId) => call("/uidai/otp/verify", { txnId, otp }, requestId),
  };
}
