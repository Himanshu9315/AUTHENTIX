import { createLogger } from "@authentix/logger";
import { startConsumer, startOutboxRelay } from "@authentix/events";
import { buildApp } from "./app.js";
import { createAdmitter } from "./admission.js";
import { createClients } from "./clients.js";
import { createPool } from "./db.js";
import { createIssuer } from "./issue.js";

const logger = createLogger("ticket-service");
const env = process.env;
const strong = (v) => v && v.length >= 32 && !v.startsWith("change-me");
if (!strong(env.INTERNAL_TOKEN)) throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
if (!env.RABBITMQ_URL) throw new Error("RABBITMQ_URL must be set");
const masterKey = Buffer.from(env.QR_MASTER_KEY ?? "", "base64");
if (masterKey.length !== 32 || (env.QR_MASTER_KEY ?? "").startsWith("change-me")) {
  throw new Error("QR_MASTER_KEY must be 32 random bytes, base64 (openssl rand -base64 32), not the .env.example placeholder");
}

const pool = await createPool(env.DATABASE_URL);
const clients = createClients({
  token: env.INTERNAL_TOKEN,
  urls: {
    auth: env.AUTH_SERVICE_URL ?? "http://localhost:3001",
    aadhaar: env.AADHAAR_SERVICE_URL ?? "http://localhost:3002",
    catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003",
    booking: env.BOOKING_SERVICE_URL ?? "http://localhost:3005",
  },
});
const relay = startOutboxRelay({ pool, url: env.RABBITMQ_URL, logger });
const consumer = startConsumer({ url: env.RABBITMQ_URL, logger, queue: "ticket-service", bindings: ["order.confirmed"], handler: createIssuer({ pool, clients }) });
const admit = createAdmitter({ pool, masterKey, graceSeconds: Number(env.SCAN_GRACE_SECONDS ?? 120) });
const app = await buildApp({ pool, logger, consumer, relay, admit, config: { masterKey, internalToken: env.INTERNAL_TOKEN } });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await consumer.stop();
    await relay.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3007), host: "0.0.0.0" });
