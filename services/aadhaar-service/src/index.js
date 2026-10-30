import { createLogger } from "@authentix/logger";
import { startOutboxRelay } from "@authentix/events";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { createUidaiClient } from "./uidai-client.js";

const logger = createLogger("aadhaar-service");
const env = process.env;
if (!env.AADHAAR_HASH_SECRET || env.AADHAAR_HASH_SECRET.length < 32 || env.AADHAAR_HASH_SECRET.startsWith("change-me")) {
  throw new Error("AADHAAR_HASH_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
if (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 32 || env.INTERNAL_TOKEN.startsWith("change-me")) {
  throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
}

const pool = await createPool(env.DATABASE_URL);
const relay = env.RABBITMQ_URL ? startOutboxRelay({ pool, url: env.RABBITMQ_URL, logger }) : undefined;
const uidai = createUidaiClient({ baseUrl: env.UIDAI_URL ?? "http://localhost:3010" });
const app = await buildApp({ pool, logger, relay, uidai, config: { hashSecret: env.AADHAAR_HASH_SECRET, internalToken: env.INTERNAL_TOKEN } });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await relay?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3002), host: "0.0.0.0" });
