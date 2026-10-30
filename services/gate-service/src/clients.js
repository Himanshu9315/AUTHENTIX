import { internalFetch } from "@authentix/internal";

/**
 * Internal calls gate-service makes. Each returns { status, json } and throws InternalHttpError if the
 * service could not be reached. Tests replace this whole object with fakes.
 * @param {{ token: string, urls: Record<"catalog"|"ticket", string> }} cfg
 */
export function createClients({ token, urls }) {
  const call = (base, path, opts = {}) => internalFetch(base + path, { token, ...opts });
  return {
    getEvent: (id, requestId) => call(urls.catalog, `/internal/events/${id}`, { requestId }),
    admit: (body, requestId) => call(urls.ticket, "/internal/admissions", { method: "POST", body, requestId }),
    ticketCounts: (eventId, requestId) => call(urls.ticket, `/internal/events/${eventId}/ticket-counts`, { requestId }),
  };
}
