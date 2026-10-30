import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { requireInternalToken } from "@authentix/internal";
import { scanRequestSchema } from "@authentix/schemas";
import { encodeToken, stepAt, STEP_MS } from "./qr.js";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();
const QR_BATCH = 10; // 10 steps = 5 minutes of codes, so a phone with weak signal at the venue keeps working

const view = (t) => ({
  id: t.id,
  eventId: t.event_id,
  tierId: t.tier_id,
  seatLabel: t.seat_label,
  status: t.status,
  holderName: t.holder_display,
  transfersLeft: 2 - t.transfer_count,
  transferable: t.status === "active" && t.transfer_count < 2,
  issuedAt: t.issued_at,
  usedAt: t.used_at,
});

/**
 * @param {{ pool: import("pg").Pool, logger: any, consumer?: { isHealthy: () => boolean }, relay?: { isHealthy: () => boolean }, admit: Function, transfers?: { transfer: Function }, config: { masterKey: Buffer, internalToken: string } }} deps
 */
export async function buildApp({ pool, logger, consumer, relay, admit, transfers, config }) {
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
      if ((consumer && !consumer.isHealthy()) || (relay && !relay.isHealthy())) return reply.code(503).send({ status: "not_ready", reason: "messaging down" });
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
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

  app.get("/tickets", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    const { rows } = await pool.query("SELECT * FROM tickets WHERE owner_user_id = $1 AND status <> 'void' ORDER BY issued_at DESC, id", [uid]);
    reply.header("cache-control", "no-store");
    return { items: rows.map(view) };
  });

  // Other people's tickets are 404, never 403, so ticket ids can't be probed.
  const ownTicket = async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return null;
    if (!uuid.safeParse(req.params.id).success) return void reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query("SELECT * FROM tickets WHERE id = $1 AND owner_user_id = $2", [req.params.id, uid]);
    if (rows.length === 0) return void reply.code(404).send({ error: "not_found" });
    return rows[0];
  };

  app.get("/tickets/:id", async (req, reply) => {
    const t = await ownTicket(req, reply);
    if (!t) return;
    reply.header("cache-control", "no-store");
    return view(t);
  });

  // The phone gets the next 10 rotating tokens at once plus the server clock. The secret never leaves this service.
  app.get("/tickets/:id/qr", async (req, reply) => {
    const t = await ownTicket(req, reply);
    if (!t) return;
    if (t.status === "used") return reply.code(409).send({ error: "ticket_used", usedAt: t.used_at, usedGate: t.used_gate });
    if (t.status === "void") return reply.code(409).send({ error: "ticket_void" });
    const nowMs = Date.now();
    const first = stepAt(nowMs);
    reply.header("cache-control", "no-store");
    return {
      ticketId: t.id,
      version: t.version,
      stepSeconds: STEP_MS / 1000,
      serverTime: new Date(nowMs).toISOString(),
      tokens: Array.from({ length: QR_BATCH }, (_, i) => ({
        step: first + i,
        token: encodeToken(config.masterKey, t.id, t.version, first + i),
        validFrom: new Date((first + i) * STEP_MS).toISOString(),
        validTo: new Date((first + i + 1) * STEP_MS).toISOString(),
      })),
    };
  });

  if (transfers) {
    app.post("/tickets/:id/transfer", async (req, reply) => transfers.handle(req, reply));
  }

  // gate-service forwards scans here. Ticket-service alone holds the key and decides.
  const admissionBody = scanRequestSchema.extend({ staffUserId: uuid, scannedAt: z.string() });
  app.post("/internal/admissions", internal, async (req, reply) => {
    const body = admissionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error" });
    return admit(body.data);
  });

  app.get("/internal/events/:id/ticket-counts", internal, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    const { rows } = await pool.query("SELECT count(*) FILTER (WHERE status <> 'void')::int AS issued, count(*) FILTER (WHERE status = 'used')::int AS used FROM tickets WHERE event_id = $1", [req.params.id]);
    return rows[0];
  });

  return app;
}
