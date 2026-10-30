import { createHash } from "node:crypto";
import { z } from "zod";
import { writeOutbox } from "@authentix/events";
import { ticketTransferredSchema, transferRequestSchema } from "@authentix/schemas";
import { holderDisplay } from "./issue.js";

const uuid = z.string().uuid();
const keySchema = z.string().min(8).max(128);
const WINDOW_MS = 24 * 3_600_000;
const NOT_ELIGIBLE = { error: "recipient_not_eligible" };

const sha = (s) => createHash("sha256").update(s).digest("hex");
const out = (status, body) => ({ status, body });

/**
 * Ticket transfers. The move itself is ONE transaction (owner + version bump + history + event), and the version bump
 * changes the derived QR secret, so the old QR is dead the instant it commits. Cap accounting happens around it:
 * reserve (recipient counted) -> move -> commit (sender released). A crash anywhere can only over-count, never let
 * anyone exceed the per-event cap. A sweeper finishes or reverts whatever a crash left behind.
 * Every "who is this email?" outcome (unknown, unverified, cap full) gives the same 422, so this can't be used to
 * discover which emails have accounts.
 * @param {{ pool: import("pg").Pool, clients: any, logger: any, now?: () => number, config?: { leaseSeconds?: number, pendingSeconds?: number } }} deps
 */
export function createTransfers({ pool, clients, logger, now = Date.now, config = {} }) {
  const leaseSeconds = config.leaseSeconds ?? 30;
  const pendingSeconds = config.pendingSeconds ?? 60;

  const replayResponse = (t, hash) => {
    if (t.request_hash !== hash) return out(422, { error: "idempotency_key_reused" });
    if (t.state === "done") return out(200, { transferId: t.id, state: "done", ticketId: t.ticket_id });
    if (t.state === "pending") return out(202, { transferId: t.id, state: "pending", ticketId: t.ticket_id });
    return t.failure_reason === "recipient_cap_exceeded" ? out(422, NOT_ELIGIBLE) : out(409, { error: "transfer_failed" });
  };

  const findByKey = async (from, key) => (await pool.query("SELECT * FROM transfers WHERE from_user = $1 AND idempotency_key = $2", [from, key])).rows[0] ?? null;

  /** pending -> failed, guarded: only one of the request handler and the sweeper can do it. */
  const fail = async (id, reason) =>
    (await pool.query("UPDATE transfers SET state = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND state = 'pending' RETURNING *", [id, reason])).rows[0] ?? null;

  const revertCap = async (t, requestId) => {
    try {
      const r = await clients.cap.revert(t.id, { eventId: t.event_id, fromHolderKey: t.from_key, toHolderKey: t.to_key }, requestId);
      if (r.status === 200) await pool.query("UPDATE transfers SET cap_settled = true, updated_at = now() WHERE id = $1", [t.id]);
      else logger.error({ transferId: t.id, status: r.status }, "cap revert refused");
    } catch {
      /* the sweeper retries */
    }
  };

  const commitCap = async (t, requestId) => {
    try {
      const r = await clients.cap.commit(t.id, requestId);
      if (r.status === 200) await pool.query("UPDATE transfers SET cap_settled = true, updated_at = now() WHERE id = $1", [t.id]);
      else logger.error({ transferId: t.id, status: r.status }, "cap commit refused");
    } catch {
      /* the sweeper retries */
    }
  };

  async function transfer({ userId, ticketId, key, recipientEmail, requestId }) {
    const hash = sha(`transfer|${ticketId}|${recipientEmail}`);
    const prior = await findByKey(userId, key);
    if (prior) return replayResponse(prior, hash);

    const ticket = (await pool.query("SELECT * FROM tickets WHERE id = $1 AND owner_user_id = $2", [ticketId, userId])).rows[0];
    if (!ticket) return out(404, { error: "not_found" });
    if (ticket.status === "used") return out(409, { error: "ticket_used" });
    if (ticket.status === "void") return out(409, { error: "ticket_void" });
    if (ticket.transfer_count >= 2) return out(422, { error: "transfer_limit_reached" });

    // Everything below fails closed: if a service we depend on is down, the answer is 503, never a guess.
    let ev, recipient, rHolder, sHolder;
    try {
      ev = await clients.getEvent(ticket.event_id, requestId);
      if (ev.status !== 200) return out(503, { error: "service_unavailable" });
      const startsAt = Date.parse(ev.json.startsAt);
      if (!Number.isFinite(startsAt)) return out(503, { error: "service_unavailable" }); // unreadable date: fail closed
      if (startsAt - now() < WINDOW_MS) return out(422, { error: "transfer_window_closed" });
      recipient = await clients.lookupUser(recipientEmail, requestId);
      if (recipient.status === 404) return out(422, NOT_ELIGIBLE);
      if (recipient.status !== 200) return out(503, { error: "service_unavailable" });
      if (recipient.json.id === userId) return out(422, { error: "cannot_transfer_to_self" });
      [rHolder, sHolder] = await Promise.all([clients.getHolder(recipient.json.id, requestId), clients.getHolder(userId, requestId)]);
    } catch {
      return out(503, { error: "service_unavailable" });
    }
    if (rHolder.status !== 200 || sHolder.status !== 200) return out(503, { error: "service_unavailable" });
    if (!recipient.json.emailVerified || !rHolder.json.verified) return out(422, NOT_ELIGIBLE);
    if (!sHolder.json.verified) return out(403, { error: "aadhaar_not_verified" });

    // Tx1: record the intent. The unique pending index allows one transfer in flight per ticket.
    let t;
    try {
      const ins = await pool.query(
        `INSERT INTO transfers (ticket_id, event_id, from_user, to_user, from_key, to_key, to_display, from_version, state, idempotency_key, request_hash, next_check_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10, now() + make_interval(secs => $11))
         ON CONFLICT (from_user, idempotency_key) DO NOTHING RETURNING *`,
        [ticketId, ticket.event_id, userId, recipient.json.id, sHolder.json.holderKey, rHolder.json.holderKey, holderDisplay(recipient.json.name), ticket.version, key, hash, pendingSeconds],
      );
      if (ins.rows.length === 0) return replayResponse(await findByKey(userId, key), hash); // the same request raced itself
      t = ins.rows[0];
    } catch (err) {
      if (err.code === "23505") return out(409, { error: "transfer_in_progress" });
      throw err;
    }

    // Reserve the recipient's cap first.
    let res;
    try {
      res = await clients.cap.reserve({ transferId: t.id, eventId: t.event_id, fromHolderKey: t.from_key, toHolderKey: t.to_key }, requestId);
    } catch {
      return out(503, { error: "try_again", transferId: t.id }); // outcome unknown; the sweeper settles it
    }
    if (res.status === 409 || (res.status === 200 && res.json?.state === "reverted")) {
      await fail(t.id, "recipient_cap_exceeded");
      await pool.query("UPDATE transfers SET cap_settled = true WHERE id = $1", [t.id]); // nothing was reserved
      return out(422, NOT_ELIGIBLE);
    }
    if (res.status !== 200) return out(503, { error: "try_again", transferId: t.id });

    // Tx2: the move.
    const client = await pool.connect();
    let moved = false;
    let lost = null;
    try {
      await client.query("BEGIN");
      const done = await client.query("UPDATE transfers SET state = 'done', updated_at = now() WHERE id = $1 AND state = 'pending' RETURNING id", [t.id]);
      if (done.rows.length === 0) {
        lost = "transfer_failed"; // the sweeper gave up on it first
      } else {
        const upd = await client.query(
          `UPDATE tickets SET owner_user_id = $2, holder_display = $3, version = version + 1, transfer_count = transfer_count + 1, updated_at = now()
           WHERE id = $1 AND owner_user_id = $4 AND version = $5 AND status = 'active' AND transfer_count < 2 RETURNING version`,
          [t.ticket_id, t.to_user, t.to_display, t.from_user, t.from_version],
        );
        if (upd.rows.length === 0) {
          lost = "ticket_changed"; // scanned in, or moved by something else, since we looked
        } else {
          const v = upd.rows[0].version;
          await client.query("INSERT INTO ticket_owners (ticket_id, version, owner_user_id, from_user_id, reason) VALUES ($1,$2,$3,$4,'transfer')", [t.ticket_id, v, t.to_user, t.from_user]);
          const payload = ticketTransferredSchema.parse({ transferId: t.id, ticketId: t.ticket_id, eventId: t.event_id, fromUserId: t.from_user, toUserId: t.to_user, newVersion: v, transferredAt: new Date().toISOString() });
          await writeOutbox(client, "ticket.transferred", payload, requestId);
          moved = true;
        }
      }
      await client.query(moved ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (!moved) {
      const failed = await fail(t.id, lost);
      await revertCap(failed ?? t, requestId);
      const now2 = (await pool.query("SELECT status FROM tickets WHERE id = $1", [t.ticket_id])).rows[0];
      return out(409, { error: now2?.status === "used" ? "ticket_used" : lost });
    }
    await commitCap(t, requestId); // release the sender; if this fails the sweeper retries
    return out(200, { transferId: t.id, state: "done", ticketId: t.ticket_id });
  }

  /** Fastify glue for POST /tickets/:id/transfer. */
  async function handle(req, reply) {
    const userId = req.headers["x-user-id"];
    const key = keySchema.safeParse(req.headers["idempotency-key"]);
    const body = transferRequestSchema.safeParse(req.body);
    if (!uuid.safeParse(userId).success) return reply.code(401).send({ error: "unauthorized" });
    if (!key.success) return reply.code(400).send({ error: "idempotency_key_required" });
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) return reply.code(400).send({ error: "validation_error" });
    const r = await transfer({ userId, ticketId: req.params.id, key: key.data, recipientEmail: body.data.recipientEmail, requestId: req.id });
    return reply.code(r.status).send(r.body);
  }

  /** Finishes or reverts whatever a crash or a slow dependency left behind. Safe with several instances. */
  async function sweepOnce() {
    const { rows } = await pool.query(
      `UPDATE transfers SET next_check_at = now() + make_interval(secs => $1)
       WHERE id IN (SELECT id FROM transfers WHERE next_check_at <= now() AND (state = 'pending' OR cap_settled = false)
                    ORDER BY next_check_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [leaseSeconds],
    );
    for (const t of rows) {
      try {
        if (t.state === "pending") {
          const failed = await fail(t.id, "timeout"); // lost the race to the request handler? then it is done, below
          if (failed) await revertCap(failed);
        } else if (t.state === "done" && !t.cap_settled) {
          await commitCap(t);
        } else if (t.state === "failed" && !t.cap_settled) {
          await revertCap(t);
        }
      } catch (err) {
        logger.error({ transferId: t.id, err: err.message }, "transfer sweep failed; will retry");
      }
    }
    return rows.length;
  }

  return { transfer, handle, sweepOnce };
}
