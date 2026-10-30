import { Redis } from "ioredis";
import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";
import { createClients } from "./clients.js";
import { createQueue } from "./queue.js";

const logger = createLogger("queue-service");
const env = process.env;
const strong = (v) => v && v.length >= 32 && !v.startsWith("change-me");
if (!strong(env.INTERNAL_TOKEN)) throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!strong(env.ADMISSION_SECRET)) throw new Error("ADMISSION_SECRET must be set to a random value (32+ chars, not the .env.example placeholder)");
if (!env.REDIS_URL) throw new Error("REDIS_URL must be set");

const config = {
  admissionSecret: env.ADMISSION_SECRET,
  batchSize: Number(env.QUEUE_BATCH_SIZE ?? 10),
  intervalSeconds: Number(env.QUEUE_INTERVAL_SECONDS ?? 5),
  admissionTtlSeconds: Number(env.ADMISSION_TTL_SECONDS ?? 600),
  // 90 s, not 30: browsers slow timers in background tabs, and a user who switches tabs must not lose their place.
  idleSeconds: Number(env.QUEUE_IDLE_SECONDS ?? 90),
};
for (const [name, v] of [["QUEUE_BATCH_SIZE", config.batchSize], ["QUEUE_INTERVAL_SECONDS", config.intervalSeconds], ["ADMISSION_TTL_SECONDS", config.admissionTtlSeconds], ["QUEUE_IDLE_SECONDS", config.idleSeconds]]) {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a whole number of at least 1`);
}
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", (err) => logger.error({ err }, "redis error"));
const queue = createQueue({ redis, config });
const clients = createClients({
  token: env.INTERNAL_TOKEN,
  urls: { catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003", auth: env.AUTH_SERVICE_URL ?? "http://localhost:3001", aadhaar: env.AADHAAR_SERVICE_URL ?? "http://localhost:3002" },
});
const app = await buildApp({ redis, queue, clients, logger, config });

// Lets the next batch in. A Redis lock makes sure only one instance does it each interval.
let running = false;
const worker = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const n = await queue.tickIfLeader();
    if (n > 0) logger.info({ admitted: n }, "admitted a batch");
  } catch (err) {
    logger.error({ err }, "admission pass failed");
  } finally {
    running = false;
  }
}, config.intervalSeconds * 1000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    clearInterval(worker);
    await app.close();
    await redis.quit();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3009), host: "0.0.0.0" });
