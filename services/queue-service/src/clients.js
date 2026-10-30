import { internalFetch } from "@authentix/internal";

/** Internal calls made when someone joins. Each returns { status, json } or throws if the service is unreachable. */
export function createClients({ token, urls }) {
  const call = (base, path, opts = {}) => internalFetch(base + path, { token, ...opts });
  return {
    getEvent: (id, requestId) => call(urls.catalog, `/internal/events/${id}`, { requestId }),
    getUser: (id, requestId) => call(urls.auth, `/internal/users/${id}`, { requestId }),
    getHolder: (id, requestId) => call(urls.aadhaar, `/internal/holders/${id}`, { requestId }),
  };
}
