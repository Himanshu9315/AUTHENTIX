import { internalFetch } from "@authentix/internal";

/**
 * Internal calls ticket-service makes. Each returns { status, json } and throws InternalHttpError if the
 * service could not be reached. Tests replace this whole object with fakes.
 * @param {{ token: string, urls: Record<"auth"|"aadhaar"|"catalog"|"booking", string> }} cfg
 */
export function createClients({ token, urls }) {
  const call = (base, path, opts = {}) => internalFetch(base + path, { token, ...opts });
  return {
    getUser: (id, requestId) => call(urls.auth, `/internal/users/${id}`, { requestId }),
    lookupUser: (email, requestId) => call(urls.auth, "/internal/users/lookup", { method: "POST", body: { email }, requestId }),
    getHolder: (id, requestId) => call(urls.aadhaar, `/internal/holders/${id}`, { requestId }),
    getEvent: (id, requestId) => call(urls.catalog, `/internal/events/${id}`, { requestId }),
    cap: {
      reserve: (body, requestId) => call(urls.booking, "/internal/cap-transfers", { method: "POST", body, requestId }),
      commit: (id, requestId) => call(urls.booking, `/internal/cap-transfers/${id}/commit`, { method: "POST", body: {}, requestId }),
      revert: (id, body, requestId) => call(urls.booking, `/internal/cap-transfers/${id}/revert`, { method: "POST", body, requestId }),
    },
  };
}
