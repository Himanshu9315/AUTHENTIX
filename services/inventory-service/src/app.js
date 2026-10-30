import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { requireInternalToken } from "@authentix/internal";
import { InvalidItems, createHoldStore, seatKey } from "./holds.js";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();

const itemSchema = z
  .object({ tierId: uuid, seatId: uuid.optional(), quantity: z.number().int().min(1).max(10).optional() })
  .refine((i) => (i.seatId === undefined) !== (i.quantity === undefined), "give either seatId or quantity");
const holdBody = z.object({
  eventId: uuid,
  items: z.array(itemSchema).min(1).max(10),
  ttlSeconds: z.number().int().min(10).max(3600).optional(),
});

/**
 * @param {{ pool: import("pg").Pool, redis: import("ioredis").Redis, logger: any, config: { internalToken: string, holdTtlSeconds: number } }} deps
 */
export async function buildApp({ pool, redis, logger, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });
  const store = createHoldStore({ pool, redis });
  const internal = { preHandler: requireInternalToken(config.internalToken) };

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await Promise.all([pool.query("SELECT 1"), redis.ping()]);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  // Public: what the seat map and quantity picker render. "held" and live GA holds come from Redis.
  app.get("/inventory/events/:eventId", async (req, reply) => {
    if (!uuid.safeParse(req.params.eventId).success) return reply.code(404).send({ error: "not_found" });
    const eventId = req.params.eventId;
    const ev = await pool.query("SELECT seat_map FROM event_inventory WHERE event_id = $1", [eventId]);
    if (ev.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const [tiers, seats, sold] = await Promise.all([
      pool.query("SELECT tier_id, kind, capacity, sold FROM tier_stock WHERE event_id = $1", [eventId]),
      pool.query("SELECT id, tier_id, section, row_label, number, x, y FROM seats WHERE event_id = $1 ORDER BY section, row_label, number", [eventId]),
      pool.query("SELECT s.seat_id FROM seat_sales s JOIN seats e ON e.id = s.seat_id WHERE e.event_id = $1", [eventId]),
    ]);
    const soldSet = new Set(sold.rows.map((r) => r.seat_id));
    const heldVals = seats.rows.length ? await redis.mget(seats.rows.map((s) => seatKey(eventId, s.id))) : [];
    const status = (s, i) => (soldSet.has(s.id) ? "sold" : heldVals[i] ? "held" : "available");
    const seatList = seats.rows.map((s, i) => ({ id: s.id, tierId: s.tier_id, section: s.section, row: s.row_label, number: s.number, x: s.x, y: s.y, status: status(s, i) }));

    const now = Date.now();
    const tierList = [];
    for (const t of tiers.rows) {
      let available;
      if (t.kind === "seated") {
        available = seatList.filter((s) => s.tierId === t.tier_id && s.status === "available").length;
      } else {
        const exp = `inv:{${eventId}}:ga:${t.tier_id}:exp`;
        const live = await redis.zrangebyscore(exp, now, "+inf");
        const qtys = live.length ? await redis.hmget(`inv:{${eventId}}:ga:${t.tier_id}:qty`, ...live) : [];
        const held = qtys.reduce((a, q) => a + Number(q ?? 0), 0);
        available = Math.max(0, t.capacity - t.sold - held);
      }
      tierList.push({ tierId: t.tier_id, kind: t.kind, available });
    }
    reply.header("cache-control", "no-store");
    return { eventId, seatMap: ev.rows[0].seat_map, tiers: tierList, seats: seatList };
  });

  const run = (fn) => async (req, reply) => {
    const parsed = holdBody.safeParse(req.body);
    if (!parsed.success || !uuid.safeParse(req.params?.orderId ?? req.body?.orderId).success) {
      return reply.code(400).send({ error: "validation_error" });
    }
    const orderId = req.params?.orderId ?? req.body.orderId;
    try {
      const out = await fn({ orderId, ...parsed.data, ttlSeconds: parsed.data.ttlSeconds ?? config.holdTtlSeconds });
      return reply.code(out.ok ? 200 : 409).send(out);
    } catch (err) {
      if (err instanceof InvalidItems) return reply.code(400).send({ error: "invalid_items" });
      throw err;
    }
  };

  app.post("/internal/holds", internal, run((a) => store.hold(a)));
  app.post("/internal/holds/:orderId/extend", internal, run((a) => store.hold(a)));
  app.post("/internal/holds/:orderId/release", internal, run((a) => store.release(a)));
  app.post("/internal/holds/:orderId/confirm", internal, run((a) => store.confirm(a)));

  return app;
}
