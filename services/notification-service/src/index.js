import { createLogger } from "@authentix/logger";
import { startConsumer } from "@authentix/events";
import { buildApp } from "./app.js";
import { createClients } from "./clients.js";
import { createPool } from "./db.js";
import { BINDINGS, createNotifier } from "./deliver.js";
import { createSmtpSink } from "./sinks.js";

const logger = createLogger("notification-service");
const env = process.env;
if (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 32 || env.INTERNAL_TOKEN.startsWith("change-me")) {
  throw new Error("INTERNAL_TOKEN must be set to a random value (32+ chars, not the .env.example placeholder)");
}
for (const name of ["DATABASE_URL", "RABBITMQ_URL", "SMTP_URL", "WEB_BASE_URL"]) if (!env[name]) throw new Error(`${name} must be set`);

const pool = await createPool(env.DATABASE_URL);
const clients = createClients({ token: env.INTERNAL_TOKEN, urls: { auth: env.AUTH_SERVICE_URL ?? "http://localhost:3001", catalog: env.CATALOG_SERVICE_URL ?? "http://localhost:3003" } });
const sink = createSmtpSink(env.SMTP_URL);
const notify = createNotifier({ pool, clients, sink, logger, config: { webBaseUrl: env.WEB_BASE_URL, mailFrom: env.MAIL_FROM ?? "Authentix <no-reply@authentix.test>" } });

// About 30 minutes of retries (90 x 20 s), so a short outage of the mail server, auth or catalog loses nothing.
// Retrying on the broker keeps the verification token out of our database. After that the message is parked for replay.
const consumer = startConsumer({ url: env.RABBITMQ_URL, logger, queue: "notification-service", bindings: BINDINGS, handler: notify, maxAttempts: 90, retryDelayMs: 20_000 });
const app = await buildApp({ pool, logger, consumer });

// Tidy up: inbox entries after 90 days, delivery records after 30.
const sweep = setInterval(() => {
  pool.query("DELETE FROM notifications WHERE created_at < now() - interval '90 days'").catch((err) => logger.error({ err }, "inbox sweep failed"));
  pool.query("DELETE FROM deliveries WHERE created_at < now() - interval '30 days'").catch((err) => logger.error({ err }, "delivery sweep failed"));
}, 3_600_000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, async () => {
    clearInterval(sweep);
    await consumer.stop();
    await app.close();
    sink.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(env.PORT ?? 3012), host: "0.0.0.0" });
