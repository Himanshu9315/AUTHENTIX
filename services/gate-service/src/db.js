import pg from "pg";

// Audit log of every scan outcome. The QR token is never stored (it is a short-lived credential); only the ticket id.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS scans (
  scan_id uuid PRIMARY KEY,
  staff_user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  gate_id text NOT NULL,
  ticket_id uuid,
  result text NOT NULL CHECK (result IN ('admitted','rejected')),
  reason text,
  holder_display text,
  seat_label text,
  tier_id uuid,
  used_at timestamptz,
  used_gate text,
  scanned_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Keyed hash of (token, gate, scannedAt): lets a retry be recognised without ever storing the token itself.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS request_hash text;
CREATE INDEX IF NOT EXISTS scans_event ON scans (event_id, created_at);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  return pool;
}
