import pg from "pg";

// Mock payments. Card numbers, CVCs and UPI ids are never stored: only the outcome, the method and a
// display hint (card last 4, or "upi").
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  order_id uuid NOT NULL,
  amount_inr int NOT NULL CHECK (amount_inr > 0),
  method text NOT NULL CHECK (method IN ('card','upi')),
  instrument_hint text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','succeeded','failed','cancelled','refunded')),
  failure_reason text,
  resolve_at timestamptz,
  resolve_to text CHECK (resolve_to IN ('succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_due ON payments (resolve_at) WHERE status = 'processing';
CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Callbacks to booking-service, written in the same transaction as the status change and delivered with retries.
CREATE TABLE IF NOT EXISTS callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  gave_up_at timestamptz
);
CREATE INDEX IF NOT EXISTS callbacks_due ON callbacks (next_attempt_at) WHERE delivered_at IS NULL AND gave_up_at IS NULL;
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  return pool;
}
