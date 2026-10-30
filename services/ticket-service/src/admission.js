import { verifyToken } from "./qr.js";

/**
 * One-time entry. The decision is a single guarded UPDATE: it only succeeds for an active ticket with the right
 * version and event, so any number of simultaneous scans of one QR (on many gates) produce exactly one admission,
 * and a transfer racing a scan on the same row can only let one of them win.
 * Rejections are business outcomes returned as data, not errors.
 * @param {{ pool: import("pg").Pool, masterKey: Buffer, graceSeconds: number, now?: () => number }} deps
 */
export function createAdmitter({ pool, masterKey, graceSeconds, now = Date.now }) {
  const rejected = (reason, extra = {}) => ({ result: "rejected", reason, ...extra });
  const admitted = (r) => ({ result: "admitted", ticketId: r.id, holderName: r.holder_display, seatLabel: r.seat_label, tierId: r.tier_id, usedAt: r.used_at, usedGate: r.used_gate });

  return async function admit({ token, eventId: rawEventId, scanId: rawScanId, gateId, staffUserId, scannedAt }) {
    const eventId = String(rawEventId).toLowerCase(); // uuids compare as text below, so normalise the case
    const scanId = String(rawScanId).toLowerCase();
    const nowMs = now();
    const scannedMs = Date.parse(scannedAt);
    if (Number.isNaN(scannedMs)) return rejected("invalid_qr");
    // A scan queued during a short network drop is judged at the moment it was captured (so a late screenshot still
    // fails), but only if it is recent. A future timestamp (bad device clock) is clamped to now.
    if (scannedMs < nowMs - graceSeconds * 1000) return rejected("scan_stale");
    const at = Math.min(scannedMs, nowMs);

    const v = verifyToken(masterKey, token, at);
    if (!v.ok) return rejected(v.reason);

    const { rows } = await pool.query(
      `UPDATE tickets SET status = 'used', used_at = now(), used_gate = $4, used_scan_id = $5, used_by = $6, updated_at = now()
       WHERE id = $1 AND version = $2 AND event_id = $3 AND status = 'active'
       RETURNING id, holder_display, seat_label, tier_id, used_at, used_gate`,
      [v.ticketId, v.version, eventId, gateId, scanId, staffUserId],
    );
    if (rows.length === 1) return admitted(rows[0]);

    // Nothing updated: work out why, most specific reason first.
    const t = (await pool.query("SELECT id, status, version, event_id, used_scan_id, used_at, used_gate, holder_display, seat_label, tier_id FROM tickets WHERE id = $1", [v.ticketId])).rows[0];
    if (!t) return rejected("invalid_qr");
    if (t.event_id !== eventId) return rejected("wrong_event");
    if (t.status === "used" && t.used_scan_id === scanId && t.version === v.version) return admitted(t); // the same scan, retried
    if (t.version !== v.version) return rejected("ticket_replaced");
    if (t.status === "used") return rejected("already_used", { holderName: t.holder_display, usedAt: t.used_at, usedGate: t.used_gate });
    return rejected("ticket_void");
  };
}
