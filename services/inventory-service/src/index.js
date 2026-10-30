import { Redis } from "ioredis";
import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";

const logger = createLogger("inventory-service");
const env = process.env;
if (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 32 || env.INTERNAL_TOKEN.startsWith("change-me")) {
  throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
if (!env.REDIS_URL) throw new Error("REDIS_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", (err) => logger.error({ err }, "redis error"));
const app = await buildApp({ pool, redis, logger, config: { internalToken: env.INTERNAL_TOKEN, holdTtlSeconds: Number(env.HOLD_TTL_SECONDS ?? 480) } });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await app.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3004), host: "0.0.0.0" });
