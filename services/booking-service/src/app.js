import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { SagaError } from "./saga.js";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();
const keySchema = z.string().min(8).max(128);

const orderBody = z.object({
  eventId: uuid,
  items: z
    .array(
      z.union([
        z.object({ tierId: uuid, quantity: z.number().int().min(1).max(10) }).strict(),
        z.object({ tierId: uuid, seatId: uuid }).strict(),
      ]),
    )
    .min(1)
    .max(10),
});

const payBody = z
  .object({
    method: z.enum(["card", "upi"]),
    card: z.object({ number: z.string().regex(/^[\d ]{12,23}$/), expMonth: z.number().int().min(1).max(12), expYear: z.number().int().min(2024).max(2100), cvc: z.string().regex(/^\d{3,4}$/) }).optional(),
    upi: z.object({ vpa: z.string().min(3).max(80) }).optional(),
  })
  .refine((b) => (b.method === "card" ? !!b.card && !b.upi : !!b.upi && !b.card), "instrument must match method");

const callbackBody = z.object({ paymentId: uuid, orderId: uuid, status: z.enum(["succeeded", "failed", "cancelled"]), occurredAt: z.string() });

/**
 * @param {{ pool: import("pg").Pool, saga: ReturnType<import("./saga.js").createSaga>, logger: any, relay?: { isHealthy: () => boolean }, config: { webhookSecret: string } }} deps
 */
export async function buildApp({ pool, saga, logger, relay, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  // Keep the raw JSON text: the payment callback signature is computed over it. An empty body is {}.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }));
    }
  });

  const userId = (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!uuid.safeParse(id).success) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return id;
  };
  const idemKey = (req, reply) => {
    const k = keySchema.safeParse(req.headers["idempotency-key"]);
    if (!k.success) {
      reply.code(400).send({ error: "idempotency_key_required" });
      return null;
    }
    return k.data;
  };
  const fail = (reply, err) => {
    if (err instanceof SagaError) return reply.code(err.status).send(err.body);
    throw err;
  };

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      if (relay && !relay.isHealthy()) return reply.code(503).send({ status: "not_ready", reason: "event relay down" });
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/booking/orders", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    const key = idemKey(req, reply);
    if (!key) return;
    const body = orderBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error" });
    try {
      const { created, order } = await saga.createOrder({ userId: uid, key, body: body.data, requestId: req.id });
      return reply.code(created ? 201 : 200).send(order);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/booking/orders", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    if (req.query.active !== "true") return reply.code(400).send({ error: "validation_error" });
    reply.header("cache-control", "no-store");
    return { order: await saga.getActiveOrder(uid) };
  });

  app.get("/booking/orders/:id", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    try {
      reply.header("cache-control", "no-store");
      return await saga.getOrder(uid, req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/booking/orders/:id/pay", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    const key = idemKey(req, reply);
    if (!key) return;
    const body = payBody.safeParse(req.body);
    if (!uuid.safeParse(req.params.id).success || !body.success) return reply.code(400).send({ error: "validation_error" });
    try {
      return reply.code(202).send(await saga.payOrder({ userId: uid, orderId: req.params.id, key, body: body.data, requestId: req.id }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/booking/orders/:id/cancel", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    if (!idemKey(req, reply)) return;
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    try {
      return await saga.cancelOrder({ userId: uid, orderId: req.params.id, requestId: req.id });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Called by payment-service. Authenticated by an HMAC over "<timestamp>.<raw body>", not by the internal token.
  app.post("/internal/payments/callback", async (req, reply) => {
    const ts = String(req.headers["x-timestamp"] ?? "");
    const sig = String(req.headers["x-signature"] ?? "");
    const expected = createHmac("sha256", config.webhookSecret).update(`${ts}.${req.rawBody ?? ""}`).digest("hex");
    const got = Buffer.from(sig);
    const want = Buffer.from(expected);
    const okSig = got.length === want.length && timingSafeEqual(got, want); // compare byte lengths: a non-ASCII header must not throw
    if (!okSig || !(Math.abs(Date.now() - Number(ts)) < 5 * 60_000)) return reply.code(401).send({ error: "bad_signature" });
    const body = callbackBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error" });
    await saga.applyPayment(body.data.orderId, body.data.paymentId, body.data.status, req.id);
    return { ok: true };
  });

  return app;
}
