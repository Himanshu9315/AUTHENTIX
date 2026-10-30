import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();
const JOINS_PER_MINUTE = 20;
// Count and expiry in one step, so a crash between them can never leave a counter that never resets.
const JOIN_LIMIT = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end return n`;

/**
 * @param {{ redis: import("ioredis").Redis, queue: ReturnType<import("./queue.js").createQueue>, clients: any, logger: any, config: { batchSize: number, intervalSeconds: number } }} deps
 */
export async function buildApp({ redis, queue, clients, logger, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  // Some clients send a JSON content-type with no body on POST/DELETE. That is an empty request, not an error.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, raw, done) => {
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }));
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await redis.ping();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  const caller = (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!uuid.safeParse(id).success) return void reply.code(401).send({ error: "unauthorized" });
    if (!uuid.safeParse(req.params.eventId).success) return void reply.code(404).send({ error: "not_found" });
    return { userId: id.toLowerCase(), eventId: req.params.eventId.toLowerCase() };
  };
  const body = (reply, status, payload) => {
    reply.header("cache-control", "no-store");
    return reply.code(status).send({ ...payload, serverTime: new Date().toISOString(), batchSize: config.batchSize, intervalSeconds: config.intervalSeconds });
  };

  // Joining checks everything once: the event really has a queue, and the person is allowed to buy. Fails closed.
  app.post("/queue/events/:eventId/join", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    // Joining makes three internal calls, so each person gets a modest allowance.
    const n = Number(await redis.eval(JOIN_LIMIT, 1, `q:join-limit:${c.userId}`));
    if (n > JOINS_PER_MINUTE) return body(reply, 429, { error: "rate_limited" });

    let ev, user, holder;
    try {
      [ev, user, holder] = await Promise.all([clients.getEvent(c.eventId, req.id), clients.getUser(c.userId, req.id), clients.getHolder(c.userId, req.id)]);
    } catch {
      return body(reply, 503, { error: "service_unavailable" });
    }
    if (ev.status === 404) return body(reply, 404, { error: "event_not_found" });
    if (ev.status !== 200 || user.status !== 200 || holder.status !== 200) return body(reply, 503, { error: "service_unavailable" });
    if (ev.json.status !== "published") return body(reply, 409, { error: "event_not_on_sale" });
    if (!ev.json.hotSale) return body(reply, 409, { error: "queue_not_needed" });
    // Only people who could actually buy may take a place in line.
    if (!user.json.emailVerified) return body(reply, 403, { error: "email_not_verified" });
    if (!holder.json.verified) return body(reply, 403, { error: "aadhaar_not_verified" });
    return body(reply, 200, await queue.join(c.userId, c.eventId));
  });

  app.get("/queue/events/:eventId/me", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    return body(reply, 200, await queue.status(c.userId, c.eventId));
  });

  app.delete("/queue/events/:eventId/me", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    await queue.leave(c.userId, c.eventId);
    return body(reply, 200, { state: "none" });
  });

  return app;
}
