import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { aadhaarOtpRequestSchema, aadhaarVerifySchema } from "@authentix/schemas";
import { writeOutbox } from "@authentix/events";
import { REQUEST_ID_HEADER } from "@authentix/logger";
import { hashAadhaar, last4 } from "./hash.js";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OTP_TTL_SECONDS = 600;
const OTP_RESEND_COOLDOWN_SECONDS = 30;
const MAX_FAILED_OTPS = 5;
const LOCK_MINUTES = 15;

/**
 * @param {{ pool: import("pg").Pool, logger: any, relay?: { isHealthy: () => boolean }, uidai: ReturnType<import("./uidai-client.js").createUidaiClient>, config: { hashSecret: string } }} deps
 */
export async function buildApp({ pool, logger, relay, uidai, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  const parse = (schema, body, reply) => {
    const r = schema.safeParse(body);
    if (!r.success) {
      reply.code(400).send({ error: "validation_error" });
      return null;
    }
    return r.data;
  };

  // The gateway verifies the JWT and forwards the user id in a header.
  const userId = (req, reply) => {
    const id = req.headers["x-user-id"];
    if (typeof id !== "string" || !UUID.test(id)) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return id;
  };

  const uidaiFailure = (reply, err) => {
    if (err?.status === 404) return reply.code(422).send({ error: "aadhaar_invalid" });
    return reply.code(502).send({ error: "uidai_unavailable" });
  };

  const lockedFor = async (id) => {
    const { rows } = await pool.query(
      "SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM locked_until - now())))::int AS secs FROM verification_attempts WHERE user_id = $1 AND locked_until > now()",
      [id],
    );
    return rows[0]?.secs ?? 0;
  };

  const isVerified = async (id) =>
    (await pool.query("SELECT 1 FROM aadhaar_verifications WHERE user_id = $1", [id])).rowCount > 0;

  const flag = (id, kind) =>
    pool.query("INSERT INTO anomaly_flags (user_id, kind) VALUES ($1, $2)", [id, kind]).catch(() => {});

  // Counted per user, atomically, so parallel guesses cannot skip the lockout.
  async function recordFailedOtp(id) {
    const { rows } = await pool.query(
      `INSERT INTO verification_attempts (user_id, failed_count) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET
         failed_count = CASE WHEN verification_attempts.failed_count + 1 >= $2 THEN 0 ELSE verification_attempts.failed_count + 1 END,
         locked_until = CASE WHEN verification_attempts.failed_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE verification_attempts.locked_until END
       RETURNING failed_count, (locked_until > now()) AS locked`,
      [id, MAX_FAILED_OTPS, LOCK_MINUTES],
    );
    const locked = rows[0].failed_count === 0 && rows[0].locked;
    if (locked) {
      await pool.query("DELETE FROM otp_sessions WHERE user_id = $1", [id]);
      await flag(id, "otp_lockout");
    }
    return { locked, attemptsLeft: locked ? 0 : MAX_FAILED_OTPS - rows[0].failed_count };
  }

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

  app.post("/aadhaar/otp", async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return;
    const data = parse(aadhaarOtpRequestSchema, req.body, reply);
    if (!data) return;
    if (await isVerified(id)) return reply.code(409).send({ error: "already_verified" });
    const lockSecs = await lockedFor(id);
    if (lockSecs > 0) return reply.code(429).send({ error: "locked", retryAfterSeconds: lockSecs });
    const recent = await pool.query(
      "SELECT 1 FROM otp_sessions WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)",
      [id, OTP_RESEND_COOLDOWN_SECONDS],
    );
    if (recent.rowCount > 0) return reply.code(429).send({ error: "too_soon" });

    let txnId;
    try {
      ({ txnId } = await uidai.sendOtp(data.aadhaar, req.id));
    } catch (err) {
      return uidaiFailure(reply, err);
    }
    // The number itself is dropped here; only its hash and last 4 digits are kept until verification.
    await pool.query(
      `INSERT INTO otp_sessions (user_id, txn_id, aadhaar_hash, last4, expires_at, created_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), now())
       ON CONFLICT (user_id) DO UPDATE SET txn_id = EXCLUDED.txn_id, aadhaar_hash = EXCLUDED.aadhaar_hash,
         last4 = EXCLUDED.last4, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [id, txnId, hashAadhaar(config.hashSecret, data.aadhaar), last4(data.aadhaar), OTP_TTL_SECONDS],
    );
    return reply.code(202).send({ expiresInSeconds: OTP_TTL_SECONDS });
  });

  app.post("/aadhaar/verify", async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return;
    const data = parse(aadhaarVerifySchema, req.body, reply);
    if (!data) return;
    if (await isVerified(id)) return reply.code(409).send({ error: "already_verified" });
    const lockSecs = await lockedFor(id);
    if (lockSecs > 0) return reply.code(429).send({ error: "locked", retryAfterSeconds: lockSecs });

    const { rows } = await pool.query(
      "SELECT txn_id, aadhaar_hash, last4 FROM otp_sessions WHERE user_id = $1 AND expires_at > now()",
      [id],
    );
    const session = rows[0];
    if (!session) return reply.code(400).send({ error: "no_active_otp" });

    try {
      await uidai.verifyOtp(session.txn_id, data.otp, req.id);
    } catch (err) {
      if (err?.code === "otp_mismatch") {
        const { locked, attemptsLeft } = await recordFailedOtp(id);
        if (locked) return reply.code(429).send({ error: "locked", retryAfterSeconds: LOCK_MINUTES * 60 });
        return reply.code(401).send({ error: "otp_invalid", attemptsLeft });
      }
      if (err?.status === 410) {
        await pool.query("DELETE FROM otp_sessions WHERE user_id = $1", [id]);
        return reply.code(400).send({ error: "otp_expired" });
      }
      return uidaiFailure(reply, err);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO aadhaar_verifications (user_id, aadhaar_hash, last4) VALUES ($1, $2, $3)", [
        id,
        session.aadhaar_hash,
        session.last4,
      ]);
      await client.query("DELETE FROM otp_sessions WHERE user_id = $1", [id]);
      await writeOutbox(client, "user.verified", { userId: id, verifiedAt: new Date().toISOString() }, req.id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") {
        // The UNIQUE constraint decides races: whichever account commits first owns this Aadhaar.
        if (err.constraint === "aadhaar_verifications_aadhaar_hash_key") {
          await pool.query("DELETE FROM otp_sessions WHERE user_id = $1", [id]);
          await flag(id, "duplicate_aadhaar_attempt");
          return reply.code(409).send({ error: "aadhaar_already_linked" });
        }
        return reply.code(409).send({ error: "already_verified" });
      }
      throw err;
    } finally {
      client.release();
    }
    return { verified: true, last4: session.last4 };
  });

  app.get("/aadhaar/status", async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return;
    const { rows } = await pool.query("SELECT last4, verified_at FROM aadhaar_verifications WHERE user_id = $1", [id]);
    if (rows.length === 0) return { verified: false };
    return { verified: true, last4: rows[0].last4, verifiedAt: rows[0].verified_at };
  });

  return app;
}
