import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { loginSchema, refreshSchema, registerSchema } from "@authentix/schemas";
import { writeOutbox } from "@authentix/events";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const ISSUER = "authentix";
const AUDIENCE = "authentix-api";
const REQUEST_ID = /^[a-f0-9]{16}$/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * @param {{ pool: import("pg").Pool, logger: any, relay?: { isHealthy: () => boolean }, config: { jwtSecret: string, accessTtl: number, refreshTtlDays: number } }} deps
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

  async function issueTokens(client, user) {
    const refreshToken = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
      [user.id, sha256(refreshToken), config.refreshTtlDays],
    );
    return { accessToken: signAccess(user), refreshToken, expiresIn: config.accessTtl };
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
      await client.query("COMMIT");
      return reply.code(201).send({ user, ...tokens });
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

  // Rotating refresh: the old token is revoked, a new pair is issued.
  app.post("/auth/refresh", async (req, reply) => {
    const data = parse(refreshSchema, req.body, reply);
    if (!data) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [sha256(data.refreshToken)],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
      const { rows: users } = await client.query("SELECT id, role FROM users WHERE id = $1", [rows[0].user_id]);
      if (users.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
      const tokens = await issueTokens(client, users[0]);
      await client.query("COMMIT");
      return tokens;
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
