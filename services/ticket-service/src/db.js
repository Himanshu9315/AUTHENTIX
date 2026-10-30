import pg from "pg";
import { OUTBOX_DDL } from "@authentix/events";

// Nothing secret is stored here: each ticket's QR secret is derived from QR_MASTER_KEY, the ticket id and its version,
// so a leaked copy of this database cannot be used to mint QR codes.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_key text NOT NULL UNIQUE,
  order_id uuid NOT NULL,
  event_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  seat_id uuid,
  seat_label text,
  owner_user_id uuid NOT NULL,
  holder_display text NOT NULL,
  version int NOT NULL DEFAULT 1,
  transfer_count int NOT NULL DEFAULT 0 CHECK (transfer_count BETWEEN 0 AND 2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','void')),
  used_at timestamptz,
  used_gate text,
  used_scan_id uuid,
  used_by uuid,
  issued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_per_seat ON tickets (event_id, seat_id) WHERE seat_id IS NOT NULL AND status <> 'void';
CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (owner_user_id, event_id);
CREATE INDEX IF NOT EXISTS tickets_event ON tickets (event_id, status);
CREATE TABLE IF NOT EXISTS ticket_owners (
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  version int NOT NULL,
  owner_user_id uuid NOT NULL,
  from_user_id uuid,
  reason text NOT NULL CHECK (reason IN ('issued','transfer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, version)
);
CREATE TABLE IF NOT EXISTS transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  event_id uuid NOT NULL,
  from_user uuid NOT NULL,
  to_user uuid NOT NULL,
  from_key text NOT NULL,
  to_key text NOT NULL,
  to_display text NOT NULL,
  from_version int NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','done','failed')),
  failure_reason text,
  cap_settled boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_user, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_transfer ON transfers (ticket_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS transfers_sweep ON transfers (next_check_at) WHERE state = 'pending' OR cap_settled = false;
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  await pool.query(SCHEMA);
  await pool.query(OUTBOX_DDL);
  return pool;
}
