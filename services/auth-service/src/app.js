import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { loginSchema, refreshSchema, registerSchema, verifyEmailSchema } from "@authentix/schemas";
import { writeOutbox } from "@authentix/events";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const ISSUER = "authentix";
const AUDIENCE = "authentix-api";
const REQUEST_ID = /^[a-f0-9]{16}$/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * @param {{ pool: import("pg").Pool, logger: any, relay?: { isHealthy: () => boolean }, config: { jwtSecret: string, accessTtl: number, refreshTtlDays: number, exposeVerificationToken?: boolean } }} deps
 */
export async function buildApp({ pool, logger, relay, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });

  const signAccess = (user) =>
    jwt.sign({ role: user.role }, config.jwtSecret, {
      subject: user.id,
      expiresIn: config.accessTtl,
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
    });

  // familyId ties a chain of rotated refresh tokens together; omit it to start a new family (login).
  async function issueTokens(client, user, familyId) {
    const refreshToken = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id) VALUES ($1, $2, now() + make_interval(days => $3), COALESCE($4::uuid, gen_random_uuid()))",
      [user.id, sha256(refreshToken), config.refreshTtlDays, familyId ?? null],
    );
    return { accessToken: signAccess(user), refreshToken, expiresIn: config.accessTtl };
  }

  // Stores a hashed one-time token and asks the notification side to email it via an event.
  async function requestEmailVerification(client, user, requestId) {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')",
      [sha256(token), user.id],
    );
    await writeOutbox(
      client,
      "user.email_verification_requested",
      { userId: user.id, email: user.email, name: user.name, token },
      requestId,
    );
    return token;
  }

  // Verified against when the email is unknown, so response time doesn't reveal which emails exist.
  const dummyHash = await argon2.hash("not-a-real-password", { type: argon2.argon2id });

  const parse = (schema, body, reply) => {
    const r = schema.safeParse(body);
    if (!r.success) {
      reply.code(400).send({ error: "validation_error", details: r.error.flatten().fieldErrors });
      return null;
    }
    return r.data;
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

  app.post("/auth/register", async (req, reply) => {
    const data = parse(registerSchema, req.body, reply);
    if (!data) return;
    const hash = await argon2.hash(data.password, { type: argon2.argon2id });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role",
        [data.email, data.name, hash],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "email_taken" });
      }
      const user = rows[0];
      await writeOutbox(client, "user.registered", { userId: user.id, email: user.email, name: user.name }, req.id);
      const tokens = await issueTokens(client, user);
      const verificationToken = await requestEmailVerification(client, user, req.id);
      await client.query("COMMIT");
      return reply
        .code(201)
        .send({ user, ...tokens, ...(config.exposeVerificationToken ? { verificationToken } : {}) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const data = parse(loginSchema, req.body, reply);
    if (!data) return;
    const { rows } = await pool.query(
      "SELECT id, email, name, role, password_hash FROM users WHERE email = $1",
      [data.email],
    );
    const user = rows[0];
    const ok = await argon2.verify(user ? user.password_hash : dummyHash, data.password).then((v) => v && !!user);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
    const tokens = await issueTokens(pool, user);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, ...tokens };
  });

  // Rotating refresh: the old token is revoked, a new pair is issued in the same family.
  // Presenting an already-revoked token means it leaked or was replayed, so the whole family is revoked.
  app.post("/auth/refresh", async (req, reply) => {
    const data = parse(refreshSchema, req.body, reply);
    if (!data) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT user_id, family_id, revoked_at, expires_at > now() AS live FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
        [sha256(data.refreshToken)],
      );
      const row = rows[0];
      if (!row || !row.live) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
      if (row.revoked_at) {
        await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [
          row.family_id,
        ]);
        await client.query("COMMIT");
        req.log.warn({ userId: row.user_id }, "refresh token reuse detected, family revoked");
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
      const { rows: users } = await client.query("SELECT id, role FROM users WHERE id = $1", [row.user_id]);
      if (users.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
      await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
        sha256(data.refreshToken),
      ]);
      const tokens = await issueTokens(client, users[0], row.family_id);
      await client.query("COMMIT");
      return tokens;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/auth/verify-email", async (req, reply) => {
    const data = parse(verifyEmailSchema, req.body, reply);
    if (!data) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "UPDATE email_verifications SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
        [sha256(data.token)],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_or_expired_token" });
      }
      await client.query("UPDATE users SET email_verified = true WHERE id = $1", [rows[0].user_id]);
      await writeOutbox(client, "user.email_verified", { userId: rows[0].user_id }, req.id);
      await client.query("COMMIT");
      return { emailVerified: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/auth/resend-verification", async (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!id) return reply.code(401).send({ error: "unauthorized" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT id, email, name, email_verified FROM users WHERE id = $1 FOR UPDATE", [id]);
      const user = rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "not_found" });
      }
      if (user.email_verified) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "already_verified" });
      }
      const { rowCount } = await client.query(
        "SELECT 1 FROM email_verifications WHERE user_id = $1 AND created_at > now() - interval '60 seconds'",
        [user.id],
      );
      if (rowCount > 0) {
        await client.query("ROLLBACK");
        return reply.code(429).send({ error: "too_soon" });
      }
      await client.query("UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
      const verificationToken = await requestEmailVerification(client, user, req.id);
      await client.query("COMMIT");
      return reply.code(202).send(config.exposeVerificationToken ? { verificationToken } : {});
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const data = parse(refreshSchema, req.body, reply);
    if (!data) return;
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
      sha256(data.refreshToken),
    ]);
    return reply.code(204).send();
  });

  // The gateway verifies the JWT and forwards the user id in a header.
  app.get("/auth/me", async (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!id) return reply.code(401).send({ error: "unauthorized" });
    const { rows } = await pool.query(
      "SELECT id, email, name, role, email_verified FROM users WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return rows[0];
  });

  return app;
}
