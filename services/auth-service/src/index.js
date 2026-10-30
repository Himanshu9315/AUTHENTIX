import { createLogger } from "@authentix/logger";
import { startOutboxRelay } from "@authentix/events";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";

const logger = createLogger("auth-service");
const env = process.env;
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith("change-me")) {
  throw new Error("JWT_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const relay = env.RABBITMQ_URL ? startOutboxRelay({ pool, url: env.RABBITMQ_URL, logger }) : undefined;
const app = await buildApp({
  pool,
  logger,
  relay,
  config: {
    jwtSecret: env.JWT_SECRET,
    accessTtl: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  },
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await relay?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3001), host: "0.0.0.0" });
