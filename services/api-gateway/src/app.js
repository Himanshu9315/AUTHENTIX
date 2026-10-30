import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import replyFrom from "@fastify/reply-from";
import jwt from "jsonwebtoken";
import { roleSchema } from "@authentix/schemas";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const PUBLIC_ROUTES = new Set(["POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/verify-email"]);
// Routes that need a specific role (first matching prefix wins). Anything else only needs a signed-in user.
const ROLE_RULES = [{ prefix: "/api/gate/", roles: ["staff"] }];
const TRANSFER_PATH = /^\/api\/tickets\/[^/]+\/transfer$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const JWT_ISSUER = "authentix";
export const JWT_AUDIENCE = "authentix-api";

/**
 * @param {{ logger: any, config: { jwtSecret: string, corsOrigins: string[], routes: Record<string,string>, rateLimitMax?: number, authRateLimitMax?: number, transferLimitPerHour?: number, trustProxy?: boolean, redis?: import("ioredis").Redis } }} deps
 * routes maps a path segment (e.g. "auth") to an upstream base URL.
 */
export async function buildApp({ logger, config }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomBytes(8).toString("hex"), // never trust a client-supplied id
    requestIdHeader: false,
    trustProxy: config.trustProxy ?? false,
  });

  const isPublic = (req) => PUBLIC_ROUTES.has(`${req.method} ${req.url.split("?")[0]}`);
  // Browsing the catalog needs no login. It keeps the normal rate-limit bucket, not the strict auth one.
  const isPublicRead = (req) => req.method === "GET" && (req.url.startsWith("/api/catalog/") || req.url.startsWith("/api/inventory/"));

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  // Public auth routes get a much stricter, separate bucket (brute-force protection).
  await app.register(rateLimit, {
    max: (req) => (isPublic(req) ? (config.authRateLimitMax ?? 10) : (config.rateLimitMax ?? 300)),
    keyGenerator: (req) => `${req.ip}:${isPublic(req) ? "auth" : "api"}`,
    timeWindow: "1 minute",
    // Shared across gateway instances and restarts. Fails open if Redis is down (availability over throttling).
    ...(config.redis ? { redis: config.redis, nameSpace: "rl:", skipOnError: true } : {}),
  });
  const transferLimiter = app.createRateLimit({
    max: config.transferLimitPerHour ?? 10,
    timeWindow: "1 hour",
    keyGenerator: (req) => `transfer:${req.userId}`,
    ...(config.redis ? { redis: config.redis, nameSpace: "rl-transfer:", skipOnError: true } : {}),
  });
  await app.register(replyFrom, { http: { requestOptions: { timeout: 10_000 } } });

  app.addHook("onSend", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    const checks = await Promise.all(
      Object.values(config.routes).map((base) =>
        fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false),
      ),
    );
    if (checks.every(Boolean)) return { status: "ready" };
    return reply.code(503).send({ status: "not_ready" });
  });

  app.all("/api/:service/*", async (req, reply) => {
    const { service } = req.params;
    if (!Object.hasOwn(config.routes, service)) return reply.code(404).send({ error: "not_found" });
    const upstream = config.routes[service];

    // /internal/* is for service-to-service calls only. The URL is forwarded verbatim, so refuse any
    // path that mentions it (even encoded) or tries to climb out of the service prefix.
    // Decode until stable so double-encoded tricks (%252e) are caught too.
    let decoded = req.url.split("?")[0];
    try {
      for (let i = 0; i < 5; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return reply.code(400).send({ error: "bad_request" });
    }
    decoded = decoded.toLowerCase();
    if (decoded.includes("/internal") || decoded.includes("..") || decoded.includes("\\") || decoded.includes("%")) return reply.code(404).send({ error: "not_found" });

    // Drop anything the client claims about identity; set it only from a verified token.
    const headers = { ...req.headers };
    delete headers["x-user-id"];
    delete headers["x-user-role"];
    delete headers["x-internal-token"];
    headers[REQUEST_ID_HEADER] = req.id;

    if (!isPublic(req) && !isPublicRead(req)) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      try {
        if (!token) throw new Error("missing token");
        const claims = jwt.verify(token, config.jwtSecret, {
          algorithms: ["HS256"],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        });
        if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) throw new Error("bad sub");
        headers["x-user-id"] = claims.sub;
        headers["x-user-role"] = roleSchema.parse(claims.role);
        req.userId = claims.sub;
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const rule = ROLE_RULES.find((r) => decoded.startsWith(r.prefix));
      if (rule && !rule.roles.includes(headers["x-user-role"])) return reply.code(403).send({ error: "forbidden" });
      // Transfers are limited per signed-in user, not per IP, so one person can't fan tickets out to many accounts quickly.
      if (req.method === "POST" && TRANSFER_PATH.test(decoded) && transferLimiter) {
        const verdict = await transferLimiter(req);
        if (!verdict.isAllowed) return reply.code(429).send({ error: "rate_limited" });
      }
    }

    // /api/auth/login -> {upstream}/auth/login
    return reply.from(upstream + req.url.replace(/^\/api/, ""), { rewriteRequestHeaders: () => headers });
  });

  return app;
}
