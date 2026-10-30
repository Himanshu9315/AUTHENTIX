import { randomUUID } from "node:crypto";
import amqp from "amqplib";

const EXCHANGE = "authentix.events";

export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
`;

/**
 * Write an event to the outbox inside the caller's transaction.
 * @param {{ query: Function }} client a pg client that is mid-transaction
 * @param {string} type e.g. "user.registered"
 * @param {Record<string, unknown>} payload
 * @param {string} [requestId]
 */
export async function writeOutbox(client, type, payload, requestId) {
  await client.query(
    "INSERT INTO outbox (id, type, payload, request_id) VALUES ($1, $2, $3, $4)",
    [randomUUID(), type, JSON.stringify(payload), requestId ?? null],
  );
}

/**
 * Poll the outbox and publish unsent rows to RabbitMQ. Reconnects with backoff.
 * Delivery is at-least-once: consumers must dedupe on messageId.
 * @param {{ pool: { query: Function, connect: Function }, url: string, logger: { error: Function, info: Function }, intervalMs?: number }} opts
 * @returns {{ stop: () => Promise<void>, isHealthy: () => boolean }}
 */
export function startOutboxRelay({ pool, url, logger, intervalMs = 1000 }) {
  let stopped = false;
  let ch = null;
  let conn = null;
  let reconnectTimer = null;
  let attempt = 0;
  let inflight = null;

  // Drop the current connection and retry once, however many events report the failure.
  const scheduleReconnect = () => {
    ch = null;
    const old = conn;
    conn = null;
    old?.removeAllListeners("close");
    old?.close().catch(() => {});
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = async () => {
    if (stopped) return;
    try {
      const c = await amqp.connect(url);
      if (stopped) return void (await c.close().catch(() => {}));
      conn = c;
      c.on("error", (err) => logger.error({ err }, "rabbitmq connection error"));
      c.on("close", scheduleReconnect);
      const channel = await c.createConfirmChannel();
      channel.on("error", (err) => logger.error({ err }, "rabbitmq channel error"));
      channel.on("close", () => {
        if (ch === channel) scheduleReconnect();
      });
      await channel.assertExchange(EXCHANGE, "topic", { durable: true });
      if (stopped) return; // stop() closes conn; don't publish a channel back
      ch = channel;
      attempt = 0;
    } catch (err) {
      logger.error({ err }, "rabbitmq connect failed, retrying");
      scheduleReconnect();
    }
  };

  const tick = async () => {
    const channel = ch;
    if (inflight || !channel) return;
    inflight = (async () => {
      let client;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT id, type, payload, request_id, created_at FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
        );
        for (const row of rows) {
          const body = Buffer.from(
            JSON.stringify({
              id: row.id,
              type: row.type,
              occurredAt: row.created_at.toISOString(),
              requestId: row.request_id ?? undefined,
              payload: row.payload,
            }),
          );
          await new Promise((resolve, reject) =>
            channel.publish(EXCHANGE, row.type, body, { persistent: true, messageId: row.id }, (err) =>
              err ? reject(err) : resolve(undefined),
            ),
          );
          await client.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client?.query("ROLLBACK").catch(() => {});
        logger.error({ err }, "outbox relay tick failed");
      } finally {
        client?.release();
        inflight = null;
      }
    })();
    await inflight;
  };

  connect();
  const timer = setInterval(tick, intervalMs);
  return {
    isHealthy: () => ch !== null,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(reconnectTimer);
      await Promise.race([inflight, new Promise((r) => setTimeout(r, 5000))]);
      const c = conn;
      conn = null;
      ch = null;
      c?.removeAllListeners("close");
      await c?.close().catch(() => {});
    },
  };
}
