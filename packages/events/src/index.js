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

/** Throw from a consumer handler for a message that can never succeed (it is parked, not retried). */
export class PermanentError extends Error {}

/**
 * Durable queue consumer with delayed retries and a parking queue, in the same reconnect style as the relay.
 * Topology: `queue` (bound to the events exchange), `queue.retry` (message TTL, dead-letters back to `queue`)
 * and `queue.parked` (no consumer; inspect by hand). A handler error nacks into the retry queue; after
 * `maxAttempts` failures, a PermanentError or malformed JSON the message is parked. Handlers must be idempotent
 * (delivery is at-least-once) and should dispatch on `event.type`, because the routing key changes after a retry hop.
 * @param {{ url: string, logger: { error: Function, info: Function, warn: Function }, queue: string, bindings: string[], handler: (event: { id: string, type: string, occurredAt: string, requestId?: string, payload: any }) => Promise<void>, prefetch?: number, maxAttempts?: number, retryDelayMs?: number }} opts
 * @returns {{ stop: () => Promise<void>, isHealthy: () => boolean }}
 */
export function startConsumer({ url, logger, queue, bindings, handler, prefetch = 10, maxAttempts = 8, retryDelayMs = 10_000 }) {
  let stopped = false;
  let conn = null;
  let ch = null;
  let reconnectTimer = null;
  let attempt = 0;

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

  const park = (channel, msg, reason) =>
    new Promise((resolve, reject) =>
      channel.sendToQueue(`${queue}.parked`, msg.content, { persistent: true, headers: { "x-parked-reason": reason } }, (err) => (err ? reject(err) : resolve(undefined))),
    );

  // Ack only once the parked copy is confirmed. If parking fails, put the message back instead of leaving it
  // unacknowledged, which would use up a prefetch slot for good and quietly stop the consumer.
  const parkThenAck = async (channel, msg, reason) => {
    try {
      await park(channel, msg, reason);
      channel.ack(msg);
    } catch (err) {
      logger.error({ err: err.message }, "could not park message; requeueing it");
      channel.nack(msg, false, true);
    }
  };

  const onMessage = async (channel, msg) => {
    if (!msg) return;
    let event;
    try {
      event = JSON.parse(msg.content.toString());
    } catch {
      return parkThenAck(channel, msg, "malformed json");
    }
    // Number of earlier failed attempts, counted by RabbitMQ in the x-death header.
    const deaths = (msg.properties.headers?.["x-death"] ?? []).find((d) => d.queue === queue && d.reason === "rejected")?.count ?? 0;
    try {
      await handler(event);
      channel.ack(msg);
    } catch (err) {
      const permanent = err instanceof PermanentError;
      if (permanent || deaths + 1 >= maxAttempts) {
        logger.error({ eventId: event?.id, type: event?.type, permanent, err: err.message }, "message parked");
        await parkThenAck(channel, msg, permanent ? err.message : "max attempts reached");
      } else {
        logger.warn({ eventId: event?.id, type: event?.type, attempt: deaths + 1, err: err.message }, "handler failed; will retry");
        channel.nack(msg, false, false); // dead-letters into the retry queue
      }
    }
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
      await channel.assertQueue(`${queue}.parked`, { durable: true });
      await channel.assertQueue(`${queue}.retry`, { durable: true, arguments: { "x-message-ttl": retryDelayMs, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": queue } });
      await channel.assertQueue(queue, { durable: true, arguments: { "x-dead-letter-exchange": "", "x-dead-letter-routing-key": `${queue}.retry` } });
      for (const key of bindings) await channel.bindQueue(queue, EXCHANGE, key);
      await channel.prefetch(prefetch);
      if (stopped) return;
      await channel.consume(queue, (msg) => {
        onMessage(channel, msg).catch((err) => logger.error({ err }, "consumer failure"));
      });
      ch = channel;
      attempt = 0;
    } catch (err) {
      logger.error({ err }, "rabbitmq consumer connect failed, retrying");
      scheduleReconnect();
    }
  };

  connect();
  return {
    isHealthy: () => ch !== null,
    stop: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      const c = conn;
      conn = null;
      ch = null;
      c?.removeAllListeners("close");
      await c?.close().catch(() => {});
    },
  };
}
