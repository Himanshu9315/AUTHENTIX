import { createHmac } from "node:crypto";
import { createLogger } from "@authentix/logger";
import { startOutboxRelay } from "@authentix/events";
import { buildApp } from "./app.js";
import { createClients } from "./clients.js";
import { createPool } from "./db.js";
import { createCapTransfers } from "./captransfer.js";
import { createSaga } from "./saga.js";

const logger = createLogger("booking-service");
const env = process.env;
const strong = (v) => v && v.length >= 32 && !v.startsWith("change-me");
if (!strong(env.INTERNAL_TOKEN)) throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!strong(env.PAYMENT_WEBHOOK_SECRET)) throw new Error("PAYMENT_WEBHOOK_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!strong(env.ADMISSION_SECRET)) throw new Error("ADMISSION_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const relay = env.RABBITMQ_URL ? startOutboxRelay({ pool, url: env.RABBITMQ_URL, logger }) : undefined;
const clients = createClients({
  token: env.INTERNAL_TOKEN,
  urls: {
    auth: env.AUTH_SERVICE_URL ?? "http://localhost:3001",
    aadhaar: env.AADHAAR_SERVICE_URL ?? "http://localhost:3002",
    catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003",
    inventory: env.INVENTORY_SERVICE_URL ?? "http://localhost:3004",
    payment: env.PAYMENT_SERVICE_URL ?? "http://localhost:3006",
  },
});
const saga = createSaga({ pool, clients, logger, config: { holdTtlSeconds: Number(env.HOLD_TTL_SECONDS ?? 480), admissionSecret: env.ADMISSION_SECRET, hashSecret: createHmac("sha256", env.PAYMENT_WEBHOOK_SECRET).update("pay-hash:v1").digest("hex") } });
const capTransfers = createCapTransfers({ pool, clients, logger });
const app = await buildApp({ pool, saga, capTransfers, logger, relay, config: { webhookSecret: env.PAYMENT_WEBHOOK_SECRET, internalToken: env.INTERNAL_TOKEN } });

// Settles anything stuck: lost callbacks, crashes mid-saga, expired holds.
let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await saga.sweepOnce();
  } catch (err) {
    logger.error({ err }, "sweeper failed");
  } finally {
    sweeping = false;
  }
}, 5000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    clearInterval(sweeper);
    await relay?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3005), host: "0.0.0.0" });
