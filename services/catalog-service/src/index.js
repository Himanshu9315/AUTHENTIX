import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";

const logger = createLogger("catalog-service");
const env = process.env;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
if (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 32 || env.INTERNAL_TOKEN.startsWith("change-me")) {
  throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
}

const pool = await createPool(env.DATABASE_URL);
const app = await buildApp({ pool, logger, internalToken: env.INTERNAL_TOKEN });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3003), host: "0.0.0.0" });
