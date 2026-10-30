import { internalFetch } from "@authentix/internal";

/** Internal lookups. Each returns { status, json } or throws if the service is unreachable. Tests replace this with fakes. */
export function createClients({ token, urls }) {
  const call = (base, path, opts = {}) => internalFetch(base + path, { token, ...opts });
  return {
    getContact: (userId, requestId) => call(urls.auth, `/internal/users/${userId}/contact`, { requestId }),
    getEvent: (eventId, requestId) => call(urls.catalog, `/internal/events/${eventId}`, { requestId }),
  };
}
