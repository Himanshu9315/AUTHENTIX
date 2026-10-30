import { createHmac } from "node:crypto";

const BACKOFF_SECONDS = [1, 5, 15, 60, 300];
const MAX_ATTEMPTS = 5;

/**
 * Two pollers: one settles payments whose simulated delay has passed, one delivers signed callbacks to
 * booking-service. Both claim rows with FOR UPDATE SKIP LOCKED, so they are safe with several instances
 * and a restart loses nothing.
 * @param {{ pool: import("pg").Pool, app: any, logger: any, config: { bookingUrl: string, webhookSecret: string } }} deps
 */
export function startWorkers({ pool, app, logger, config }) {
  let stopped = false;

  async function settleDue() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT id, resolve_to, failure_reason FROM payments WHERE status = 'processing' AND resolve_at <= now() ORDER BY resolve_at LIMIT 20 FOR UPDATE SKIP LOCKED",
      );
      for (const p of rows) await app.settle(client, p.id, p.resolve_to, p.failure_reason);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error({ err }, "settle poller failed");
    } finally {
      client.release();
    }
  }

  async function deliverDue() {
    // Lease the rows first, then do HTTP outside any lock.
    const { rows } = await pool.query(
      `UPDATE callbacks SET next_attempt_at = now() + interval '30 seconds'
       WHERE id IN (SELECT id FROM callbacks WHERE delivered_at IS NULL AND gave_up_at IS NULL AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, payload, attempts`,
    );
    for (const cb of rows) {
      const raw = JSON.stringify(cb.payload);
      const ts = String(Date.now());
      const sig = createHmac("sha256", config.webhookSecret).update(`${ts}.${raw}`).digest("hex");
      let ok = false;
      try {
        const res = await fetch(`${config.bookingUrl}/internal/payments/callback`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
          body: raw,
          signal: AbortSignal.timeout(3000),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      const attempts = cb.attempts + 1;
      if (ok) await pool.query("UPDATE callbacks SET delivered_at = now(), attempts = $2 WHERE id = $1", [cb.id, attempts]);
      else if (attempts >= MAX_ATTEMPTS) {
        // booking-service's sweeper asks us for the status, so a lost callback is recoverable
        await pool.query("UPDATE callbacks SET gave_up_at = now(), attempts = $2 WHERE id = $1", [cb.id, attempts]);
        logger.warn({ callbackId: cb.id }, "callback delivery gave up");
      } else {
        await pool.query("UPDATE callbacks SET attempts = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1", [cb.id, attempts, BACKOFF_SECONDS[attempts - 1]]);
      }
    }
  }

  const tick = async () => {
    if (stopped) return;
    await settleDue();
    await deliverDue().catch((err) => logger.error({ err }, "callback poller failed"));
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, 1000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
