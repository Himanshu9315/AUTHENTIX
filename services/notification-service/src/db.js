import pg from "pg";

// deliveries records only THAT something was sent: no address, no body, no token (so a leaked copy reveals nothing).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  dedupe_key text PRIMARY KEY,
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  template text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending','sent','suppressed')),
  attempts int NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_user_recent ON deliveries (user_id, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at DESC, id DESC);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  return pool;
}
