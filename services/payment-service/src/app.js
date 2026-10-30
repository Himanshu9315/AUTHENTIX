import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { requireInternalToken } from "@authentix/internal";
import { resolveInstrument } from "./instruments.js";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();

const createSchema = z
  .object({
    orderId: uuid,
    amountInr: z.number().int().min(1).max(1_000_000),
    method: z.enum(["card", "upi"]),
    card: z.object({
      number: z.string().regex(/^[\d ]{12,23}$/),
      expMonth: z.number().int().min(1).max(12),
      expYear: z.number().int().min(2024).max(2100),
      cvc: z.string().regex(/^\d{3,4}$/),
    }).optional(),
    upi: z.object({ vpa: z.string().min(3).max(80) }).optional(),
  })
  .refine((b) => (b.method === "card" ? !!b.card && !b.upi : !!b.upi && !b.card), "instrument must match method");

const keySchema = z.string().min(8).max(128);

const view = (p) => ({
  id: p.id,
  orderId: p.order_id,
  amountInr: p.amount_inr,
  method: p.method,
  instrumentHint: p.instrument_hint,
  status: p.status,
  failureReason: p.failure_reason,
});

/**
 * @param {{ pool: import("pg").Pool, logger: any, config: { internalToken: string, delayMs: { normal: number, slow: number }, hangAutoFailMs: number } }} deps
 */
export async function buildApp({ pool, logger, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });
  const internal = { preHandler: requireInternalToken(config.internalToken) };

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  // Guarded transition: only one actor (poller, cancel call) can move a payment out of "processing".
  // The callback row is written in the same transaction, so a final status is never lost.
  async function settle(client, id, to, reason) {
    const { rows } = await client.query(
      `UPDATE payments SET status = $2, failure_reason = $3, updated_at = now(), resolve_at = NULL
       WHERE id = $1 AND status = 'processing' RETURNING id, order_id, status`,
      [id, to, reason ?? null],
    );
    if (rows.length === 0) return false;
    await client.query("INSERT INTO callbacks (payment_id, payload) VALUES ($1, $2)", [
      id,
      JSON.stringify({ paymentId: id, orderId: rows[0].order_id, status: to, occurredAt: new Date().toISOString() }),
    ]);
    return true;
  }
  app.decorate("settle", settle);

  app.post("/internal/payments", internal, async (req, reply) => {
    const key = keySchema.safeParse(req.headers["idempotency-key"]);
    const body = createSchema.safeParse(req.body);
    if (!key.success || !body.success) return reply.code(400).send({ error: "validation_error" });
    const b = body.data;
    const instrument = resolveInstrument(b.method, b.card, b.upi);
    if (!instrument) return reply.code(400).send({ error: "unsupported_test_instrument" });

    const requestHash = createHash("sha256").update(`${b.orderId}|${b.amountInr}|${b.method}`).digest("hex");
    const delay = instrument.outcome === "hang" ? config.hangAutoFailMs : config.delayMs[instrument.delay];
    const resolveTo = instrument.outcome === "hang" ? "failed" : instrument.outcome;
    const { rows } = await pool.query(
      `INSERT INTO payments (idempotency_key, request_hash, order_id, amount_inr, method, instrument_hint, status, resolve_at, resolve_to, failure_reason)
       VALUES ($1,$2,$3,$4,$5,$6,'processing', now() + make_interval(secs => $7), $8, $9)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [key.data, requestHash, b.orderId, b.amountInr, b.method, instrument.hint, delay / 1000, resolveTo, instrument.outcome === "hang" ? "timeout" : (instrument.reason ?? null)],
    );
    if (rows.length > 0) return reply.code(201).send(view(rows[0]));
    const existing = (await pool.query("SELECT * FROM payments WHERE idempotency_key = $1", [key.data])).rows[0];
    if (existing.request_hash !== requestHash) return reply.code(422).send({ error: "idempotency_key_reused" });
    return reply.code(200).send(view(existing)); // same request again: return the original, never charge twice
  });

  // Lets booking find a payment whose create reply it never received (the key is derived: pay:{orderId}:{attempt}).
  app.get("/internal/payments/by-key/:key", internal, async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query("SELECT * FROM payments WHERE idempotency_key = $1", [key.data]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return view(rows[0]);
  });

  app.get("/internal/payments/:id", internal, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return view(rows[0]);
  });

  // Gives booking a definite answer when a payment is stuck: a processing payment becomes cancelled,
  // a payment that already finished is returned unchanged.
  app.post("/internal/payments/:id/cancel", internal, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await settle(client, req.params.id, "cancelled", "cancelled");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return view(rows[0]);
  });

  app.post("/internal/payments/:id/refund", internal, async (req, reply) => {
    const key = keySchema.safeParse(req.headers["idempotency-key"]);
    if (!key.success || !uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: "validation_error" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT status FROM payments WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "not_found" });
      }
      if (rows[0].status === "refunded") {
        await client.query("COMMIT");
        return { id: req.params.id, status: "refunded" }; // already refunded: same answer again
      }
      if (rows[0].status !== "succeeded") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "not_refundable", status: rows[0].status });
      }
      await client.query("INSERT INTO refunds (payment_id, idempotency_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.id, key.data]);
      await client.query("UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1", [req.params.id]);
      await client.query("COMMIT");
      return { id: req.params.id, status: "refunded" };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  return app;
}
