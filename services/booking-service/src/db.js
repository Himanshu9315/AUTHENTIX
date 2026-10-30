import pg from "pg";
import { OUTBOX_DDL } from "@authentix/events";

// holder_key is a derived per-Aadhaar key from aadhaar-service (never the Aadhaar hash itself).
// cap_held makes sure an order's share of the per-event ticket cap is released exactly once.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  holder_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','HELD','PAYMENT_PENDING','PAID','CONFIRMED','FAILED','CANCELLED','EXPIRED','REFUND_PENDING','REFUNDED')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  units int NOT NULL CHECK (units BETWEEN 1 AND 10),
  total_inr int NOT NULL CHECK (total_inr >= 0),
  cap_held boolean NOT NULL DEFAULT true,
  hold_expires_at timestamptz,
  payment_deadline timestamptz,
  current_payment_id uuid,
  attempts int NOT NULL DEFAULT 0,
  failure_reason text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS retries int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_sweep ON orders (next_check_at) WHERE state IN ('PENDING','HELD','PAYMENT_PENDING','PAID','REFUND_PENDING');
CREATE INDEX IF NOT EXISTS orders_user ON orders (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tier_id uuid NOT NULL,
  seat_id uuid,
  seat_label text,
  qty int NOT NULL CHECK (qty >= 1),
  unit_price_inr int NOT NULL CHECK (unit_price_inr >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
CREATE TABLE IF NOT EXISTS payment_attempts (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  payment_id uuid,
  PRIMARY KEY (order_id, attempt_no),
  UNIQUE (order_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS cap_usage (
  event_id uuid NOT NULL,
  holder_key text NOT NULL,
  qty int NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (event_id, holder_key)
);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  await pool.query(SCHEMA);
  await pool.query(OUTBOX_DDL);
  return pool;
}
