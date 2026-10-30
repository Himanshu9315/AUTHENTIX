import { createHash, createHmac } from "node:crypto";
import { writeOutbox } from "@authentix/events";
import { orderConfirmedSchema, orderRefundedSchema } from "@authentix/schemas";

// Order state machine (every change is a guarded UPDATE ... WHERE state = expected, so the request
// handler, the payment callback and the sweeper can race safely):
//   PENDING -> HELD -> PAYMENT_PENDING -> PAID -> CONFIRMED
//   PAYMENT_PENDING -> HELD (retry) | FAILED;  HELD -> CANCELLED | EXPIRED
//   PAID -> REFUND_PENDING -> REFUNDED   (seats were lost after the customer paid)
export const MAX_ATTEMPTS = 3;
const ACTIVE = ["PENDING", "HELD", "PAYMENT_PENDING", "PAID", "REFUND_PENDING"];

export class SagaError extends Error {
  /** @param {number} status @param {Record<string, unknown>} body */
  constructor(status, body) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const canonical = (v) => JSON.stringify(sortKeys(v));

/**
 * @param {{ pool: import("pg").Pool, clients: any, logger: any, config?: Partial<{ holdTtlSeconds: number, payHoldSeconds: number, paymentTimeoutSeconds: number, holdMinRemainingSeconds: number, pendingTimeoutSeconds: number, leaseSeconds: number, hashSecret: string }> }} deps
 */
export function createSaga({ pool, clients, logger, config = {} }) {
  const cfg = {
    holdTtlSeconds: 480,
    payHoldSeconds: 180,
    paymentTimeoutSeconds: 60,
    holdMinRemainingSeconds: 30,
    pendingTimeoutSeconds: 30,
    leaseSeconds: 30,
    hashSecret: "dev-only-request-hash-secret",
    ...config,
  };

  const loadOrder = async (db, id) => (await db.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0] ?? null;
  const loadItems = async (db, id) => (await db.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY seat_label NULLS LAST, tier_id", [id])).rows;
  const invItems = (items) => items.map((i) => (i.seat_id ? { tierId: i.tier_id, seatId: i.seat_id } : { tierId: i.tier_id, quantity: i.qty }));

  const view = (o, items) => ({
    id: o.id,
    state: o.state,
    eventId: o.event_id,
    items: items.map((i) => ({ tierId: i.tier_id, seatId: i.seat_id, seatLabel: i.seat_label, quantity: i.qty, unitPriceInr: i.unit_price_inr })),
    totalInr: o.total_inr,
    holdExpiresAt: o.hold_expires_at,
    serverTime: new Date().toISOString(),
    attempts: o.attempts,
    failureReason: o.failure_reason,
    createdAt: o.created_at,
  });
  const viewById = async (id) => view(await loadOrder(pool, id), await loadItems(pool, id));

  /** Guarded transition. Returns the updated row, or null if another actor already moved the order. */
  async function move(db, id, from, to, extra = {}) {
    const cols = Object.keys(extra); // column names come from this file only
    const sets = cols.map((c, i) => `, ${c} = $${i + 4}`).join("");
    const { rows } = await db.query(
      `UPDATE orders SET state = $2, updated_at = now(), retries = 0${sets} WHERE id = $1 AND state = ANY($3) RETURNING *`,
      [id, to, from, ...cols.map((c) => extra[c])],
    );
    return rows[0] ?? null;
  }

  /** Enters a final state and gives the order's share of the per-event cap back, exactly once, in one transaction. */
  async function toTerminal(id, from, to, reason) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `WITH old AS (SELECT id, cap_held, units, event_id, holder_key FROM orders WHERE id = $1 AND state = ANY($2) FOR UPDATE)
         UPDATE orders o SET state = $3, cap_held = false, failure_reason = COALESCE($4, o.failure_reason),
           updated_at = now(), next_check_at = now() + interval '1 day'
         FROM old WHERE o.id = old.id
         RETURNING old.cap_held AS was_held, old.units, old.event_id, old.holder_key, o.user_id, o.failure_reason AS reason`,
        [id, from, to, reason ?? null],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const r = rows[0];
      if (r.was_held) {
        await client.query("UPDATE cap_usage SET qty = GREATEST(0, qty - $3) WHERE event_id = $1 AND holder_key = $2", [r.event_id, r.holder_key, r.units]);
      }
      if (to === "REFUNDED") {
        const payload = orderRefundedSchema.parse({ orderId: id, userId: r.user_id, eventId: r.event_id, reason: r.reason, refundedAt: new Date().toISOString() });
        await writeOutbox(client, "order.refunded", payload);
      }
      await client.query("COMMIT");
      return r;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Redis holds expire by themselves, so a failed release is harmless: log and move on.
  async function releaseHold(order, requestId) {
    try {
      await clients.inventory.release(order.id, { eventId: order.event_id, items: invItems(await loadItems(pool, order.id)) }, requestId);
    } catch (err) {
      logger.warn({ orderId: order.id, err: err.message }, "hold release failed (it will expire on its own)");
    }
  }

  // Exponential backoff for a dependency that is down: 5s, 15s, 45s, 135s, then every 5 minutes.
  const retryLater = (id) =>
    pool.query(
      "UPDATE orders SET retries = retries + 1, next_check_at = now() + make_interval(secs => LEAST(300, 5 * power(3, LEAST(retries, 5)))) WHERE id = $1",
      [id],
    );

  // ---------------------------------------------------------------- create

  const findByKey = async (userId, key) => (await pool.query("SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2", [userId, key])).rows[0] ?? null;

  async function replay(existing, requestHash) {
    if (existing.request_hash !== requestHash) throw new SagaError(422, { error: "idempotency_key_reused" });
    return { created: false, order: await viewById(existing.id) }; // current state, not a byte-identical replay
  }

  async function createOrder({ userId, key, body, requestId }) {
    const requestHash = sha(`POST /booking/orders|${canonical(body)}`);
    const existing = await findByKey(userId, key);
    if (existing) return replay(existing, requestHash);

    // Eligibility, price and cap all come from the owning services, never from the client. Fail closed.
    let user, holder, event;
    try {
      [user, holder, event] = await Promise.all([clients.getUser(userId, requestId), clients.getHolder(userId, requestId), clients.getEvent(body.eventId, requestId)]);
    } catch {
      throw new SagaError(503, { error: "service_unavailable" });
    }
    if (user.status === 404) throw new SagaError(403, { error: "account_not_found" });
    if (user.status !== 200 || holder.status !== 200) throw new SagaError(503, { error: "service_unavailable" });
    if (!user.json.emailVerified) throw new SagaError(403, { error: "email_not_verified" });
    if (!holder.json.verified) throw new SagaError(403, { error: "aadhaar_not_verified" });
    if (event.status === 404) throw new SagaError(404, { error: "event_not_found" });
    if (event.status !== 200) throw new SagaError(503, { error: "service_unavailable" });
    if (event.json.status !== "published" || new Date(event.json.startsAt) <= new Date()) throw new SagaError(422, { error: "event_not_on_sale" });

    const price = new Map(event.json.tiers.map((t) => [t.id, t.priceInr]));
    if (body.items.some((i) => !price.has(i.tierId))) throw new SagaError(400, { error: "invalid_items" });
    const seatIds = body.items.filter((i) => i.seatId).map((i) => i.seatId);
    if (new Set(seatIds).size !== seatIds.length) throw new SagaError(400, { error: "invalid_items" });
    const labels = new Map();
    if (seatIds.length) {
      let desc;
      try {
        desc = await clients.describeSeats(body.eventId, seatIds, requestId);
      } catch {
        throw new SagaError(503, { error: "service_unavailable" });
      }
      if (desc.status !== 200) throw new SagaError(desc.status === 400 ? 400 : 503, { error: desc.status === 400 ? "invalid_items" : "service_unavailable" });
      for (const s of desc.json.seats) labels.set(s.id, s);
      if (body.items.some((i) => i.seatId && labels.get(i.seatId)?.tierId !== i.tierId)) throw new SagaError(400, { error: "invalid_items" });
    }
    const rows = body.items.map((i) => ({ tierId: i.tierId, seatId: i.seatId ?? null, seatLabel: i.seatId ? labels.get(i.seatId).label : null, qty: i.quantity ?? 1, price: price.get(i.tierId) }));
    const units = rows.reduce((a, r) => a + r.qty, 0);
    if (units > 10) throw new SagaError(400, { error: "too_many_tickets" });
    const total = rows.reduce((a, r) => a + r.qty * r.price, 0);
    const cap = event.json.ticketCap;

    const client = await pool.connect();
    let orderId;
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO orders (user_id, event_id, holder_key, state, idempotency_key, request_hash, units, total_inr, next_check_at)
         VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7, now() + make_interval(secs => $8))
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
        [userId, body.eventId, holder.json.holderKey, key, requestHash, units, total, cfg.pendingTimeoutSeconds],
      );
      if (ins.rows.length === 0) {
        await client.query("ROLLBACK"); // a concurrent request with the same key won
        return replay(await findByKey(userId, key), requestHash);
      }
      orderId = ins.rows[0].id;
      // The row lock on (event, holder) serialises parallel orders by the same Aadhaar, so the cap can't be beaten by racing.
      const capRes = await client.query(
        `INSERT INTO cap_usage (event_id, holder_key, qty) SELECT $1::uuid, $2::text, $3::int WHERE $3::int <= $4::int
         ON CONFLICT (event_id, holder_key) DO UPDATE SET qty = cap_usage.qty + EXCLUDED.qty
           WHERE cap_usage.qty + EXCLUDED.qty <= $4::int
         RETURNING qty`,
        [body.eventId, holder.json.holderKey, units, cap],
      );
      if (capRes.rows.length === 0) {
        const cur = await client.query("SELECT qty FROM cap_usage WHERE event_id = $1 AND holder_key = $2", [body.eventId, holder.json.holderKey]);
        await client.query("ROLLBACK");
        throw new SagaError(409, { error: "ticket_cap_exceeded", cap, remaining: Math.max(0, cap - (cur.rows[0]?.qty ?? 0)) });
      }
      for (const r of rows) {
        await client.query("INSERT INTO order_items (order_id, tier_id, seat_id, seat_label, qty, unit_price_inr) VALUES ($1,$2,$3,$4,$5,$6)", [orderId, r.tierId, r.seatId, r.seatLabel, r.qty, r.price]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    let res;
    try {
      res = await clients.inventory.hold({ orderId, eventId: body.eventId, items: invItems(await loadItems(pool, orderId)), ttlSeconds: cfg.holdTtlSeconds }, requestId);
    } catch {
      // Unknown outcome. The order stays PENDING and the sweeper settles it.
      throw new SagaError(503, { error: "try_again", orderId });
    }
    if (res.status === 200) {
      await move(pool, orderId, ["PENDING"], "HELD", { hold_expires_at: res.json.expiresAt, next_check_at: res.json.expiresAt });
      return { created: true, order: await viewById(orderId) };
    }
    const reason = res.status === 409 ? res.json.error : "hold_failed";
    await toTerminal(orderId, ["PENDING"], "FAILED", reason);
    if (res.status === 409) throw new SagaError(409, { error: reason, seatIds: res.json.seatIds, tierId: res.json.tierId });
    throw new SagaError(502, { error: "hold_failed" });
  }

  // ---------------------------------------------------------------- pay

  async function payOrder({ userId, orderId, key, body, requestId }) {
    const order = await loadOrder(pool, orderId);
    if (!order || order.user_id !== userId) throw new SagaError(404, { error: "not_found" });
    // The hash must change when the card/UPI id changes, but must not be reversible: keyed, and only last 4 / handle go in.
    const instrument = body.method === "card" ? body.card.number.replace(/\s/g, "").slice(-4) : body.upi.vpa.trim().toLowerCase();
    const reqHash = createHmac("sha256", cfg.hashSecret).update(`pay|${orderId}|${body.method}|${instrument}`).digest("hex");
    const prior = (await pool.query("SELECT request_hash FROM payment_attempts WHERE order_id = $1 AND idempotency_key = $2", [orderId, key])).rows[0];
    if (prior) {
      if (prior.request_hash !== reqHash) throw new SagaError(422, { error: "idempotency_key_reused" });
      return viewById(orderId);
    }

    const client = await pool.connect();
    let attemptNo;
    try {
      await client.query("BEGIN");
      const moved = await client.query(
        `UPDATE orders SET state = 'PAYMENT_PENDING', attempts = attempts + 1, updated_at = now(), current_payment_id = NULL,
           payment_deadline = now() + make_interval(secs => $2), next_check_at = now() + make_interval(secs => $2 + 5)
         WHERE id = $1 AND state = 'HELD' AND attempts < $3 AND hold_expires_at > now() + make_interval(secs => $4)
         RETURNING attempts`,
        [orderId, cfg.paymentTimeoutSeconds, MAX_ATTEMPTS, cfg.holdMinRemainingSeconds],
      );
      if (moved.rows.length === 0) {
        await client.query("ROLLBACK");
        // A parallel request with the same key may have just moved the order: that is a repeat, not an error.
        const raced = (await pool.query("SELECT request_hash FROM payment_attempts WHERE order_id = $1 AND idempotency_key = $2", [orderId, key])).rows[0];
        if (raced) {
          if (raced.request_hash !== reqHash) throw new SagaError(422, { error: "idempotency_key_reused" });
          return viewById(orderId);
        }
        const o = await loadOrder(pool, orderId);
        if (o.state === "HELD" && o.attempts >= MAX_ATTEMPTS) throw new SagaError(409, { error: "payment_attempts_exhausted" });
        if (o.state === "HELD") throw new SagaError(409, { error: "hold_expired" });
        throw new SagaError(409, { error: "invalid_state", state: o.state });
      }
      attemptNo = moved.rows[0].attempts;
      await client.query("INSERT INTO payment_attempts (order_id, attempt_no, idempotency_key, request_hash) VALUES ($1,$2,$3,$4)", [orderId, attemptNo, key, reqHash]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") return viewById(orderId); // same key raced in parallel: it is already being handled
      throw err;
    } finally {
      client.release();
    }

    // Keep the seats while the payment is in flight. Losing them here means nothing was charged yet.
    try {
      const ext = await clients.inventory.extend(orderId, { eventId: order.event_id, items: invItems(await loadItems(pool, orderId)), ttlSeconds: cfg.payHoldSeconds }, requestId);
      if (ext.status === 409) {
        await toTerminal(orderId, ["PAYMENT_PENDING"], "FAILED", "seats_unavailable");
        throw new SagaError(409, { error: "seats_unavailable" });
      }
    } catch (err) {
      if (err instanceof SagaError) throw err;
      logger.warn({ orderId }, "hold extend failed; continuing, confirm will re-check");
    }

    let res;
    try {
      res = await clients.payment.create(`pay:${orderId}:${attemptNo}`, { orderId, amountInr: order.total_inr, method: body.method, card: body.card, upi: body.upi }, requestId);
    } catch {
      return viewById(orderId); // outcome unknown: the callback or the sweeper settles it
    }
    if (res.status === 200 || res.status === 201) {
      await pool.query("UPDATE payment_attempts SET payment_id = $3 WHERE order_id = $1 AND attempt_no = $2", [orderId, attemptNo, res.json.id]);
      await pool.query("UPDATE orders SET current_payment_id = $2 WHERE id = $1 AND state = 'PAYMENT_PENDING' AND current_payment_id IS NULL", [orderId, res.json.id]);
    } else if (res.status === 400) {
      // Not a real attempt (unsupported test instrument): put the order back so the user can try again.
      await pool.query("DELETE FROM payment_attempts WHERE order_id = $1 AND attempt_no = $2", [orderId, attemptNo]);
      await move(pool, orderId, ["PAYMENT_PENDING"], "HELD", { attempts: attemptNo - 1, payment_deadline: null, next_check_at: order.hold_expires_at });
      throw new SagaError(400, { error: res.json.error ?? "payment_rejected" });
    }
    return viewById(orderId);
  }

  // ---------------------------------------------------------------- payment results, confirm, refund

  async function confirmPaid(order, requestId) {
    let res;
    try {
      res = await clients.inventory.confirm(order.id, { eventId: order.event_id, items: invItems(await loadItems(pool, order.id)) }, requestId);
    } catch {
      return retryLater(order.id);
    }
    if (res.status === 200) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const done = await move(client, order.id, ["PAID"], "CONFIRMED", { next_check_at: new Date(Date.now() + 86_400_000) });
        if (done) {
          const items = await loadItems(client, order.id);
          const payload = orderConfirmedSchema.parse({
            orderId: order.id,
            userId: order.user_id,
            eventId: order.event_id,
            items: items.map((i) => ({ tierId: i.tier_id, seatId: i.seat_id, seatLabel: i.seat_label, quantity: i.qty, unitPriceInr: i.unit_price_inr })),
            totalInr: order.total_inr,
            confirmedAt: new Date().toISOString(),
          });
          await writeOutbox(client, "order.confirmed", payload);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else if (res.status === 409) {
      // The seats are gone (hold expired and someone else took them). Money was taken, so refund.
      const moved = await move(pool, order.id, ["PAID"], "REFUND_PENDING", { failure_reason: res.json.error === "sold_out" ? "sold_out" : "seats_unavailable", next_check_at: new Date() });
      if (moved) await doRefund(moved, requestId);
    } else {
      await retryLater(order.id);
    }
  }

  async function doRefund(order, requestId) {
    let res;
    try {
      res = await clients.payment.refund(order.current_payment_id, `refund:${order.current_payment_id}`, requestId);
    } catch {
      return retryLater(order.id);
    }
    if (res.status === 200) {
      if (await toTerminal(order.id, ["REFUND_PENDING"], "REFUNDED", null)) await releaseHold(order, requestId);
    } else if (res.status === 409 && ["failed", "cancelled"].includes(res.json.status)) {
      await toTerminal(order.id, ["REFUND_PENDING"], "FAILED", "payment_failed"); // nothing was charged
    } else {
      await retryLater(order.id);
    }
  }

  // A success for a payment this order is not using (a second charge) must never be kept. This throws on
  // failure on purpose: from a callback it makes the endpoint answer 5xx, so payment-service retries the callback.
  async function refundStray(orderId, paymentId, requestId) {
    const res = await clients.payment.refund(paymentId, `refund:${paymentId}`, requestId);
    if (res.status !== 200) {
      logger.error({ orderId, paymentId, status: res.status }, "stray payment refund was not accepted");
      throw new Error(`stray refund rejected (${res.status})`);
    }
  }

  /**
   * Applies a final payment status from the callback or the sweeper. Safe to call any number of times.
   * `trusted` means the caller already fetched this payment as the order's current one (the sweeper).
   */
  async function applyPayment(orderId, paymentId, status, requestId, { trusted = false, attempt: expectedAttempt } = {}) {
    const order = await loadOrder(pool, orderId);
    if (!order) return;
    // The sweeper looked at a specific attempt; if the order has moved on to a newer one, its answer is stale.
    if (trusted && expectedAttempt !== undefined && order.attempts !== expectedAttempt) return;
    // Which attempt does this payment belong to? Only the order's latest attempt may change its state.
    const attempt = paymentId ? (await pool.query("SELECT attempt_no FROM payment_attempts WHERE order_id = $1 AND payment_id = $2", [orderId, paymentId])).rows[0] : null;
    const isCurrent = trusted || order.current_payment_id === paymentId || attempt?.attempt_no === order.attempts;
    // The create reply may not be stored yet when a very fast success callback arrives: adopt it.
    const unrecorded = !!paymentId && !attempt && order.state === "PAYMENT_PENDING" && order.current_payment_id === null;

    if (status === "succeeded") {
      if (order.state === "PAYMENT_PENDING" && (isCurrent || unrecorded)) {
        const paid = await move(pool, orderId, ["PAYMENT_PENDING"], "PAID", { current_payment_id: paymentId, next_check_at: new Date() });
        if (paid) await confirmPaid(paid, requestId);
        return;
      }
      if (order.current_payment_id === paymentId && ["CONFIRMED", "PAID", "REFUND_PENDING", "REFUNDED"].includes(order.state)) return; // duplicate callback
      if (["CONFIRMED", "PAID", "REFUND_PENDING", "REFUNDED", "PAYMENT_PENDING"].includes(order.state)) return refundStray(orderId, paymentId, requestId);
      // The customer was charged but the order had already ended (for example it timed out): give the money back.
      const late = await move(pool, orderId, ["PENDING", "HELD", "FAILED", "EXPIRED", "CANCELLED"], "REFUND_PENDING", { current_payment_id: paymentId, failure_reason: "late_payment", next_check_at: new Date() });
      if (late) await doRefund(late, requestId);
      return;
    }

    // failed / cancelled: only the current attempt counts. An unknown payment id is left to the sweeper.
    if (order.state !== "PAYMENT_PENDING" || !isCurrent) return;
    const canRetry = order.attempts < MAX_ATTEMPTS && order.hold_expires_at && order.hold_expires_at.getTime() > Date.now() + cfg.holdMinRemainingSeconds * 1000;
    if (canRetry) {
      await move(pool, orderId, ["PAYMENT_PENDING"], "HELD", { payment_deadline: null, current_payment_id: null, next_check_at: order.hold_expires_at });
    } else if (await toTerminal(orderId, ["PAYMENT_PENDING"], "FAILED", "payment_failed")) {
      await releaseHold(order, requestId);
    }
  }

  async function cancelOrder({ userId, orderId, requestId }) {
    const order = await loadOrder(pool, orderId);
    if (!order || order.user_id !== userId) throw new SagaError(404, { error: "not_found" });
    if (order.state === "CANCELLED") return viewById(orderId);
    if (!(await toTerminal(orderId, ["HELD"], "CANCELLED", "cancelled_by_user"))) {
      throw new SagaError(409, { error: "invalid_state", state: (await loadOrder(pool, orderId)).state });
    }
    await releaseHold(order, requestId);
    return viewById(orderId);
  }

  async function getOrder(userId, orderId) {
    const order = await loadOrder(pool, orderId);
    if (!order || order.user_id !== userId) throw new SagaError(404, { error: "not_found" });
    return view(order, await loadItems(pool, orderId));
  }

  async function getActiveOrder(userId) {
    const { rows } = await pool.query("SELECT id FROM orders WHERE user_id = $1 AND state = ANY($2) ORDER BY created_at DESC LIMIT 1", [userId, ACTIVE]);
    return rows[0] ? viewById(rows[0].id) : null;
  }

  // ---------------------------------------------------------------- sweeper

  async function sweepOne(o) {
    const now = Date.now();
    if (o.state === "PENDING") {
      if (now - o.created_at.getTime() >= cfg.pendingTimeoutSeconds * 1000 && (await toTerminal(o.id, ["PENDING"], "FAILED", "hold_failed"))) await releaseHold(o);
    } else if (o.state === "HELD") {
      if (o.hold_expires_at && o.hold_expires_at.getTime() <= now && (await toTerminal(o.id, ["HELD"], "EXPIRED", "hold_expired"))) await releaseHold(o);
    } else if (o.state === "PAYMENT_PENDING") {
      if (!o.payment_deadline || o.payment_deadline.getTime() > now) return;
      if (!o.current_payment_id) {
        // The create call's reply never arrived. Ask payment-service whether it created the payment.
        const found = await clients.payment.byKey(`pay:${o.id}:${o.attempts}`);
        if (found.status === 404) return applyPayment(o.id, null, "failed", undefined, { trusted: true, attempt: o.attempts }); // never created: nothing was charged
        if (found.status !== 200) return;
        await pool.query("UPDATE payment_attempts SET payment_id = $3 WHERE order_id = $1 AND attempt_no = $2 AND payment_id IS NULL", [o.id, o.attempts, found.json.id]);
        await pool.query("UPDATE orders SET current_payment_id = $2 WHERE id = $1 AND state = 'PAYMENT_PENDING' AND current_payment_id IS NULL", [o.id, found.json.id]);
        o.current_payment_id = found.json.id;
      }
      let p = await clients.payment.get(o.current_payment_id);
      if (p.status === 200 && p.json.status === "processing") p = await clients.payment.cancel(o.current_payment_id); // forces a definite outcome
      if (p.status === 200 && p.json.status !== "processing") await applyPayment(o.id, o.current_payment_id, p.json.status, undefined, { trusted: true, attempt: o.attempts });
    } else if (o.state === "PAID") {
      await confirmPaid(o);
    } else if (o.state === "REFUND_PENDING") {
      await doRefund(o);
    }
  }

  /** One sweep. Safe with several instances: rows are leased with SKIP LOCKED, then worked on outside the lock. */
  async function sweepOnce() {
    const { rows } = await pool.query(
      `UPDATE orders SET next_check_at = now() + make_interval(secs => $1)
       WHERE id IN (SELECT id FROM orders WHERE state = ANY($2) AND next_check_at <= now() ORDER BY next_check_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [cfg.leaseSeconds, ACTIVE],
    );
    for (const o of rows) {
      try {
        await sweepOne(o);
      } catch (err) {
        logger.error({ orderId: o.id, err: err.message }, "sweep failed; will retry");
      }
    }
    return rows.length;
  }

  return { createOrder, payOrder, cancelOrder, getOrder, getActiveOrder, applyPayment, sweepOnce };
}
