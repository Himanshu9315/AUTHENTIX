import { createHmac } from "node:crypto";
import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createClients } from "./clients.js";
import { createPool } from "./db.js";

const logger = createLogger("gate-service");
const env = process.env;
if (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 32 || env.INTERNAL_TOKEN.startsWith("change-me")) {
  throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const clients = createClients({
  token: env.INTERNAL_TOKEN,
  urls: { catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003", ticket: env.TICKET_SERVICE_URL ?? "http://localhost:3007" },
});
const app = await buildApp({ pool, clients, logger, config: { hashSecret: createHmac("sha256", env.INTERNAL_TOKEN).update("scan-hash:v1").digest("hex"), openBeforeHours: Number(env.GATE_OPEN_BEFORE_HOURS ?? 6), openAfterHours: Number(env.GATE_OPEN_AFTER_HOURS ?? 12) } });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3008), host: "0.0.0.0" });
