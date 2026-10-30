import { z } from "zod";

const uuid = z.string().uuid();
const keySchema = z.string().min(8).max(128);
const body = z.object({ transferId: uuid, eventId: uuid, fromHolderKey: keySchema, toHolderKey: keySchema });
const revertBody = body.omit({ transferId: true });

/**
 * Moves one unit of the per-event ticket cap between two Aadhaar holders when a ticket is transferred.
 * Order matters: reserve (recipient counted) -> ticket moves -> commit (sender released). At every step in
 * between, including a crash, the cap is over-counted, never under-counted, so nobody can exceed it.
 * @param {{ pool: import("pg").Pool, clients: { getEvent: Function }, logger: any }} deps
 */
export function createCapTransfers({ pool, clients, logger }) {
  const decrement = (db, eventId, key) =>
    db.query("UPDATE cap_usage SET qty = GREATEST(0, qty - 1) WHERE event_id = $1 AND holder_key = $2", [eventId, key]);

  return {
    async reserve(raw, requestId) {
      const b = body.safeParse(raw);
      if (!b.success) return { status: 400, body: { error: "validation_error" } };
      const { transferId, eventId, fromHolderKey, toHolderKey } = b.data;
      // The cap comes from catalog, never from the caller. If catalog is down, refuse rather than guess.
      let ev;
      try {
        ev = await clients.getEvent(eventId, requestId);
      } catch {
        return { status: 503, body: { error: "service_unavailable" } };
      }
      if (ev.status !== 200) return { status: ev.status === 404 ? 404 : 503, body: { error: ev.status === 404 ? "event_not_found" : "service_unavailable" } };
      const cap = ev.json.ticketCap;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const ins = await client.query(
          "INSERT INTO cap_transfers (id, event_id, from_key, to_key, state) VALUES ($1,$2,$3,$4,'reserved') ON CONFLICT (id) DO NOTHING RETURNING id",
          [transferId, eventId, fromHolderKey, toHolderKey],
        );
        if (ins.rows.length === 0) {
          // Seen before (a retry, or a tombstone from an early revert): report its state, change nothing.
          const ex = await client.query("SELECT state FROM cap_transfers WHERE id = $1", [transferId]);
          await client.query("ROLLBACK");
          return { status: 200, body: { state: ex.rows[0].state } };
        }
        const capRes = await client.query(
          `INSERT INTO cap_usage (event_id, holder_key, qty) SELECT $1::uuid, $2::text, 1 WHERE 1 <= $3::int
           ON CONFLICT (event_id, holder_key) DO UPDATE SET qty = cap_usage.qty + 1 WHERE cap_usage.qty + 1 <= $3::int
           RETURNING qty`,
          [eventId, toHolderKey, cap],
        );
        if (capRes.rows.length === 0) {
          await client.query("ROLLBACK"); // also removes the cap_transfers row
          return { status: 409, body: { error: "ticket_cap_exceeded" } };
        }
        await client.query("COMMIT");
        return { status: 200, body: { state: "reserved" } };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async commit(id) {
      if (!uuid.safeParse(id).success) return { status: 404, body: { error: "not_found" } };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "UPDATE cap_transfers SET state = 'committed', updated_at = now() WHERE id = $1 AND state = 'reserved' RETURNING event_id, from_key",
          [id],
        );
        if (rows.length === 1) {
          await decrement(client, rows[0].event_id, rows[0].from_key); // sender released exactly once, in the same transaction
          await client.query("COMMIT");
          return { status: 200, body: { state: "committed" } };
        }
        const ex = await client.query("SELECT state FROM cap_transfers WHERE id = $1", [id]);
        await client.query("ROLLBACK");
        if (ex.rows.length === 0) return { status: 404, body: { error: "not_found" } };
        if (ex.rows[0].state === "committed") return { status: 200, body: { state: "committed" } }; // repeat: no-op
        return { status: 409, body: { error: "already_reverted" } };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async revert(id, raw) {
      const b = revertBody.safeParse(raw);
      if (!uuid.safeParse(id).success || !b.success) return { status: 400, body: { error: "validation_error" } };
      const { eventId, fromHolderKey, toHolderKey } = b.data;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // An unknown id becomes a tombstone, so a reserve that arrives late can never apply.
        await client.query(
          "INSERT INTO cap_transfers (id, event_id, from_key, to_key, state) VALUES ($1,$2,$3,$4,'reverted') ON CONFLICT (id) DO NOTHING",
          [id, eventId, fromHolderKey, toHolderKey],
        );
        const { rows } = await client.query("SELECT state, to_key FROM cap_transfers WHERE id = $1 FOR UPDATE", [id]);
        const row = rows[0];
        if (row.state === "committed") {
          await client.query("ROLLBACK");
          return { status: 409, body: { error: "already_committed" } }; // ticket-service never asks for this
        }
        if (row.state === "reserved") {
          await client.query("UPDATE cap_transfers SET state = 'reverted', updated_at = now() WHERE id = $1", [id]);
          await decrement(client, eventId, row.to_key); // give the recipient's reserved unit back
        }
        await client.query("COMMIT");
        return { status: 200, body: { state: "reverted" } };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error({ err: err.message }, "cap transfer revert failed");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
