import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { startWorkers } from "./worker.js";

const logger = createLogger("payment-service");
const env = process.env;
const strong = (v) => v && v.length >= 32 && !v.startsWith("change-me");
if (!strong(env.INTERNAL_TOKEN)) throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!strong(env.PAYMENT_WEBHOOK_SECRET)) throw new Error("PAYMENT_WEBHOOK_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const app = await buildApp({
  pool,
  logger,
  config: {
    internalToken: env.INTERNAL_TOKEN,
    delayMs: { normal: Number(env.PAYMENT_DELAY_MS ?? 1000), slow: Number(env.PAYMENT_SLOW_DELAY_MS ?? 20000) },
    hangAutoFailMs: Number(env.PAYMENT_HANG_AUTOFAIL_MS ?? 300000),
  },
});
const workers = startWorkers({
  pool,
  app,
  logger,
  config: { bookingUrl: env.BOOKING_URL ?? "http://localhost:3005", webhookSecret: env.PAYMENT_WEBHOOK_SECRET },
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    workers.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3006), host: "0.0.0.0" });
