import { internalFetch } from "@authentix/internal";

/**
 * Typed wrappers over the internal HTTP calls booking makes. Each returns { status, json } and throws
 * InternalHttpError if the service could not be reached. Tests replace this whole object with fakes.
 * @param {{ token: string, urls: Record<"auth"|"aadhaar"|"catalog"|"inventory"|"payment", string> }} cfg
 */
export function createClients({ token, urls }) {
  const call = (base, path, opts = {}) => internalFetch(base + path, { token, ...opts });
  return {
    getUser: (id, requestId) => call(urls.auth, `/internal/users/${id}`, { requestId }),
    getHolder: (id, requestId) => call(urls.aadhaar, `/internal/holders/${id}`, { requestId }),
    getEvent: (id, requestId) => call(urls.catalog, `/internal/events/${id}`, { requestId }),
    describeSeats: (eventId, seatIds, requestId) => call(urls.inventory, "/internal/seats/describe", { method: "POST", body: { eventId, seatIds }, requestId }),
    inventory: {
      hold: (body, requestId) => call(urls.inventory, "/internal/holds", { method: "POST", body, requestId }),
      extend: (orderId, body, requestId) => call(urls.inventory, `/internal/holds/${orderId}/extend`, { method: "POST", body, requestId }),
      release: (orderId, body, requestId) => call(urls.inventory, `/internal/holds/${orderId}/release`, { method: "POST", body, requestId }),
      confirm: (orderId, body, requestId) => call(urls.inventory, `/internal/holds/${orderId}/confirm`, { method: "POST", body, requestId }),
    },
    payment: {
      create: (key, body, requestId) => call(urls.payment, "/internal/payments", { method: "POST", body, headers: { "idempotency-key": key }, requestId }),
      byKey: (key, requestId) => call(urls.payment, `/internal/payments/by-key/${encodeURIComponent(key)}`, { requestId }),
      get: (id, requestId) => call(urls.payment, `/internal/payments/${id}`, { requestId }),
      cancel: (id, requestId) => call(urls.payment, `/internal/payments/${id}/cancel`, { method: "POST", body: {}, requestId }),
      refund: (id, key, requestId) => call(urls.payment, `/internal/payments/${id}/refund`, { method: "POST", body: {}, headers: { "idempotency-key": key }, requestId }),
    },
  };
}
