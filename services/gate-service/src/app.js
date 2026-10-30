import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { scanRequestSchema } from "@authentix/schemas";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();
const EVENT_CACHE_MS = 60_000;

const response = (r, serverTime) => ({
  scanId: r.scan_id,
  result: r.result,
  reason: r.reason,
  holderName: r.holder_display,
  seatLabel: r.seat_label,
  tierId: r.tier_id,
  usedAt: r.used_at,
  usedGate: r.used_gate,
  serverTime,
});

/**
 * Staff-facing scan API. It owns who scanned what and when (the audit log) and makes retries safe; the actual
 * decision, and the QR key, stay in ticket-service.
 * @param {{ pool: import("pg").Pool, clients: any, logger: any, now?: () => number, config?: { openBeforeHours?: number, openAfterHours?: number, hashSecret?: string } }} deps
 */
export async function buildApp({ pool, clients, logger, now = Date.now, config = {} }) {
  // A gate scans only around the event. Default: from 6 h before to 12 h after the start. Widened in the dev .env so a demo can scan any event.
  const OPEN_BEFORE_MS = (config.openBeforeHours ?? 6) * 3_600_000;
  const OPEN_AFTER_MS = (config.openAfterHours ?? 12) * 3_600_000;
  if (!config.hashSecret) throw new Error("gate-service needs config.hashSecret");
  const fingerprint = (b) => createHmac("sha256", config.hashSecret).update(`${b.token}|${b.gateId}|${b.scannedAt}`).digest("hex");
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  // Event start times, cached briefly so a busy gate does not hit catalog on every scan.
  const eventCache = new Map();
  async function startsAt(eventId, requestId) {
    const hit = eventCache.get(eventId);
    if (hit && hit.until > now()) return hit.startsAt;
    const res = await clients.getEvent(eventId, requestId);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`catalog answered ${res.status}`);
    const t = Date.parse(res.json.startsAt);
    if (!Number.isFinite(t)) throw new Error("catalog sent an unreadable start time"); // fail closed: never treat a bad date as 'open'
    eventCache.set(eventId, { startsAt: t, until: now() + EVENT_CACHE_MS });
    return t;
  }

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  // The gateway already limits /api/gate to staff; checking again here means a gateway mistake can't open the door.
  const staff = (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!uuid.safeParse(id).success) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (req.headers["x-user-role"] !== "staff") {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return id.toLowerCase();
  };

  app.post("/gate/scans", async (req, reply) => {
    const staffId = staff(req, reply);
    if (!staffId) return;
    const parsed = scanRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error" });
    const b = { ...parsed.data, scanId: parsed.data.scanId.toLowerCase(), eventId: parsed.data.eventId.toLowerCase() };
    reply.header("cache-control", "no-store");

    // A retry (the scanner never got our answer) returns the stored answer, whatever the ticket's state is now.
    const prior = (await pool.query("SELECT * FROM scans WHERE scan_id = $1", [b.scanId])).rows[0];
    if (prior) {
      // The same scanId must mean the same scan. A different QR, gate or time under a used id is refused, so a reused id
      // can never replay another ticket's green screen.
      if (prior.staff_user_id !== staffId || prior.event_id !== b.eventId || (prior.request_hash && prior.request_hash !== fingerprint(b))) {
        return reply.code(422).send({ error: "scan_id_reused" });
      }
      return response(prior, new Date(now()).toISOString());
    }

    let outcome;
    try {
      const start = await startsAt(b.eventId, req.id);
      if (start === null || now() < start - OPEN_BEFORE_MS || now() > start + OPEN_AFTER_MS) {
        outcome = { result: "rejected", reason: "event_not_open" };
      } else {
        const res = await clients.admit({ token: b.token, eventId: b.eventId, scanId: b.scanId, gateId: b.gateId, staffUserId: staffId, scannedAt: b.scannedAt }, req.id);
        if (res.status !== 200) throw new Error(`ticket-service answered ${res.status}`);
        outcome = res.json;
      }
    } catch {
      // Nothing is stored, so the scanner can retry the same scanId safely.
      return reply.code(503).send({ error: "try_again" });
    }

    await pool.query(
      `INSERT INTO scans (scan_id, staff_user_id, event_id, gate_id, ticket_id, result, reason, holder_display, seat_label, tier_id, used_at, used_gate, scanned_at, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (scan_id) DO NOTHING`,
      [b.scanId, staffId, b.eventId, b.gateId, outcome.ticketId ?? null, outcome.result, outcome.reason ?? null, outcome.holderName ?? null, outcome.seatLabel ?? null, outcome.tierId ?? null, outcome.usedAt ?? null, outcome.usedGate ?? null, b.scannedAt, fingerprint(b)],
    );
    // First writer wins: if two retries raced, both get the same stored answer.
    const stored = (await pool.query("SELECT * FROM scans WHERE scan_id = $1", [b.scanId])).rows[0];
    logger.info({ scanId: b.scanId, result: stored.result, reason: stored.reason }, "scan recorded");
    return response(stored, new Date(now()).toISOString());
  });

  app.get("/gate/events/:eventId/stats", async (req, reply) => {
    if (!staff(req, reply)) return;
    if (!uuid.safeParse(req.params.eventId).success) return reply.code(404).send({ error: "not_found" });
    const eventId = req.params.eventId.toLowerCase();
    const { rows } = await pool.query(
      "SELECT count(*) FILTER (WHERE result = 'admitted')::int AS admitted, count(*) FILTER (WHERE result = 'rejected')::int AS rejected, max(created_at) AS last_scan_at FROM scans WHERE event_id = $1",
      [eventId],
    );
    let counts = { issued: null, used: null };
    try {
      const res = await clients.ticketCounts(eventId, req.id);
      if (res.status === 200) counts = res.json;
    } catch {
      /* the scan counts still work if ticket-service is briefly unreachable */
    }
    reply.header("cache-control", "no-store");
    return { admitted: rows[0].admitted, rejected: rows[0].rejected, issued: counts.issued, used: counts.used, lastScanAt: rows[0].last_scan_at, serverTime: new Date(now()).toISOString() };
  });

  return app;
}
