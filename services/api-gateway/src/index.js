import { Redis } from "ioredis";
import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";

const logger = createLogger("api-gateway");
const env = process.env;
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith("change-me")) {
  throw new Error("JWT_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
}

const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : undefined;
redis?.on("error", (err) => logger.error({ err }, "redis error"));

const app = await buildApp({
  logger,
  config: {
    jwtSecret: env.JWT_SECRET,
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(","),
    routes: {
      auth: env.AUTH_SERVICE_URL ?? "http://localhost:3001",
      aadhaar: env.AADHAAR_SERVICE_URL ?? "http://localhost:3002",
      catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003",
    },
    redis,
    trustProxy: env.TRUST_PROXY === "true",
  },
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => app.close().then(() => redis?.quit()).then(() => process.exit(0)));
}

await app.listen({ port: Number(env.PORT ?? 3000), host: "0.0.0.0" });
