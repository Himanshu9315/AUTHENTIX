import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";

const logger = createLogger("catalog-service");
const env = process.env;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const pool = await createPool(env.DATABASE_URL);
const app = await buildApp({ pool, logger });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3003), host: "0.0.0.0" });
