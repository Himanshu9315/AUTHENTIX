import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { eventsQuerySchema } from "@authentix/schemas";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { requireInternalToken } from "@authentix/internal";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,98}$/;

const EVENT_COLUMNS = `e.id, e.slug, e.title, e.category, e.poster_url, e.starts_at, e.ends_at, e.hot_sale, e.verified_entry,
  v.name AS venue_name, v.city,
  (SELECT min(t.price_inr) FROM ticket_tiers t WHERE t.event_id = e.id) AS price_from`;

const toEvent = (r) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  category: r.category,
  posterUrl: r.poster_url,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  hotSale: r.hot_sale,
  verifiedEntry: r.verified_entry,
  priceFrom: r.price_from,
  venue: { name: r.venue_name, city: r.city },
  distanceKm: r.distance_km ?? null,
});

const escapeLike = (s) => s.replace(/[\\%_]/g, "\\$&");

/**
 * Public read API. Organiser writes arrive with the admin dashboard in Phase 8.
 * @param {{ pool: import("pg").Pool, logger: any, internalToken: string }} deps
 */
export async function buildApp({ pool, logger, internalToken }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.method === "GET" && reply.statusCode === 200 && !req.url.startsWith("/internal") && !req.url.startsWith("/healthz") && !req.url.startsWith("/readyz")) {
      reply.header("cache-control", "public, max-age=30");
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/catalog/events", async (req, reply) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error" });
    const f = parsed.data;

    const params = [];
    const p = (v) => (params.push(v), `$${params.length}`);
    const where = ["e.status = 'published'", "e.ends_at > now()"];
    if (f.city) where.push(`v.city = ${p(f.city)}`);
    if (f.category) where.push(`e.category = ${p(f.category)}`);
    if (f.hot !== undefined) where.push(`e.hot_sale = ${p(f.hot)}`);
    if (f.q) {
      const like = p(`%${escapeLike(f.q)}%`);
      where.push(`(e.title ILIKE ${like} OR v.name ILIKE ${like} OR EXISTS (
        SELECT 1 FROM event_artists ea JOIN artists a ON a.id = ea.artist_id WHERE ea.event_id = e.id AND a.name ILIKE ${like}))`);
    }
    let distance = "NULL::numeric";
    if (f.lat !== undefined) {
      const lat = p(f.lat);
      const lng = p(f.lng);
      // Great-circle distance in km (haversine via spherical law of cosines), clamped against rounding error.
      distance = `round((6371 * acos(least(1, cos(radians(${lat})) * cos(radians(v.lat)) * cos(radians(v.lng) - radians(${lng})) + sin(radians(${lat})) * sin(radians(v.lat)))))::numeric, 1)::float8`;
    }
    const limit = p(f.limit);
    const offset = p(f.offset);
    const { rows } = await pool.query(
      `SELECT ${EVENT_COLUMNS}, ${distance} AS distance_km
       FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.starts_at, e.id LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map(toEvent) };
  });

  app.get("/catalog/events/:slug", async (req, reply) => {
    const { slug } = req.params;
    if (!SLUG.test(slug)) return reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query(
      `SELECT ${EVENT_COLUMNS}, e.description, e.ticket_cap, v.address, v.lat, v.lng
       FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.slug = $1 AND e.status = 'published'`,
      [slug],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const r = rows[0];
    const [artists, tiers] = await Promise.all([
      pool.query(
        `SELECT a.slug, a.name, a.image_url FROM event_artists ea JOIN artists a ON a.id = ea.artist_id
         WHERE ea.event_id = $1 ORDER BY a.name`,
        [r.id],
      ),
      pool.query("SELECT id, name, description, price_inr FROM ticket_tiers WHERE event_id = $1 ORDER BY price_inr", [r.id]),
    ]);
    return {
      ...toEvent(r),
      description: r.description,
      ticketCap: r.ticket_cap,
      venue: { name: r.venue_name, city: r.city, address: r.address, lat: r.lat, lng: r.lng },
      artists: artists.rows.map((a) => ({ slug: a.slug, name: a.name, imageUrl: a.image_url })),
      tiers: tiers.rows.map((t) => ({ id: t.id, name: t.name, description: t.description, priceInr: t.price_inr })),
    };
  });

  // Artists with an upcoming event, for the "Artists in your city" chips.
  app.get("/catalog/artists", async (req, reply) => {
    const city = typeof req.query.city === "string" && req.query.city.length <= 60 ? req.query.city : null;
    const { rows } = await pool.query(
      `SELECT DISTINCT a.slug, a.name, a.image_url
       FROM artists a JOIN event_artists ea ON ea.artist_id = a.id
       JOIN events e ON e.id = ea.event_id AND e.status = 'published' AND e.ends_at > now()
       JOIN venues v ON v.id = e.venue_id
       WHERE ($1::text IS NULL OR v.city = $1) ORDER BY a.name LIMIT 30`,
      [city],
    );
    return { items: rows.map((a) => ({ slug: a.slug, name: a.name, imageUrl: a.image_url })) };
  });

  app.get("/catalog/cities", async () => {
    const { rows } = await pool.query(
      `SELECT v.city, avg(v.lat) AS lat, avg(v.lng) AS lng, count(DISTINCT e.id)::int AS events
       FROM venues v JOIN events e ON e.venue_id = v.id AND e.status = 'published' AND e.ends_at > now()
       GROUP BY v.city ORDER BY v.city`,
    );
    return { items: rows.map((c) => ({ city: c.city, lat: c.lat, lng: c.lng, events: c.events })) };
  });

  // Booking reads price and cap from here, never from the client. Internal only (not routed by the gateway).
  app.get("/internal/events/:id", { preHandler: requireInternalToken(internalToken) }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query("SELECT id, status, starts_at, ticket_cap, hot_sale FROM events WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const tiers = await pool.query("SELECT id, price_inr FROM ticket_tiers WHERE event_id = $1", [req.params.id]);
    const e = rows[0];
    return {
      id: e.id,
      status: e.status,
      startsAt: e.starts_at,
      ticketCap: e.ticket_cap,
      hotSale: e.hot_sale,
      tiers: tiers.rows.map((t) => ({ id: t.id, priceInr: t.price_inr })),
    };
  });

  return app;
}
