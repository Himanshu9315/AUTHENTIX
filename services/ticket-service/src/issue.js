import { PermanentError } from "@authentix/events";
import { writeOutbox } from "@authentix/events";
import { orderConfirmedSchema, ticketIssuedSchema } from "@authentix/schemas";

/** "Asha Kulkarni" -> "Asha K." The only form of the name the gate ever sees. */
export function holderDisplay(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Guest";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
}

/**
 * Handler for order.confirmed. Idempotent: every ticket has a deterministic issue_key, so a redelivered
 * message inserts nothing and emits nothing.
 * @param {{ pool: import("pg").Pool, clients: any }} deps
 */
export function createIssuer({ pool, clients }) {
  return async function issue(event) {
    if (event.type !== "order.confirmed") return;
    const parsed = orderConfirmedSchema.safeParse(event.payload);
    if (!parsed.success) throw new PermanentError("order.confirmed payload failed validation");
    const o = parsed.data;

    let res;
    try {
      res = await clients.getUser(o.userId, event.requestId);
    } catch {
      throw new Error("auth-service unreachable"); // transient: retried later
    }
    if (res.status === 404) throw new PermanentError("ticket holder not found");
    if (res.status !== 200) throw new Error(`auth-service answered ${res.status}`);
    const display = holderDisplay(res.json.name);

    // One ticket per seat, or per general-admission unit. Keys are deterministic so redelivery is harmless.
    const gaCounter = new Map();
    const units = [];
    for (const item of o.items) {
      if (item.seatId) {
        units.push({ key: `${o.orderId}:${item.seatId}`, tierId: item.tierId, seatId: item.seatId, seatLabel: item.seatLabel });
      } else {
        for (let i = 0; i < item.quantity; i++) {
          const n = (gaCounter.get(item.tierId) ?? 0) + 1;
          gaCounter.set(item.tierId, n);
          units.push({ key: `${o.orderId}:${item.tierId}:ga:${n}`, tierId: item.tierId, seatId: null, seatLabel: null });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const issued = [];
      for (const u of units) {
        const { rows } = await client.query(
          `INSERT INTO tickets (issue_key, order_id, event_id, tier_id, seat_id, seat_label, owner_user_id, holder_display)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (issue_key) DO NOTHING RETURNING id`,
          [u.key, o.orderId, o.eventId, u.tierId, u.seatId, u.seatLabel, o.userId, display],
        );
        if (rows.length === 0) continue;
        issued.push(rows[0].id);
        await client.query("INSERT INTO ticket_owners (ticket_id, version, owner_user_id, reason) VALUES ($1, 1, $2, 'issued')", [rows[0].id, o.userId]);
      }
      if (issued.length > 0) {
        const payload = ticketIssuedSchema.parse({ orderId: o.orderId, userId: o.userId, eventId: o.eventId, ticketIds: issued, issuedAt: new Date().toISOString() });
        await writeOutbox(client, "ticket.issued", payload, event.requestId);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // Two live tickets for one seat means inventory and booking disagree: never retry that, park it for a human.
      if (err.code === "23505" && err.constraint === "tickets_one_per_seat") throw new PermanentError("seat already has a live ticket");
      throw err;
    } finally {
      client.release();
    }
  };
}
