import pg from "pg";

// Inventory owns stock and seat state only. Prices live in catalog, so there is one price source.
// seat_sales.seat_id PRIMARY KEY is what makes selling a seat twice impossible; CHECK (sold <= capacity)
// plus a guarded UPDATE does the same for general admission.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_inventory (
  event_id uuid PRIMARY KEY,
  seat_map jsonb
);
CREATE TABLE IF NOT EXISTS tier_stock (
  tier_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event_inventory(event_id),
  kind text NOT NULL CHECK (kind IN ('ga','seated')),
  capacity int NOT NULL CHECK (capacity >= 0),
  sold int NOT NULL DEFAULT 0,
  CHECK (sold BETWEEN 0 AND capacity)
);
CREATE TABLE IF NOT EXISTS seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES event_inventory(event_id),
  tier_id uuid NOT NULL REFERENCES tier_stock(tier_id),
  section text NOT NULL,
  row_label text NOT NULL,
  number int NOT NULL,
  x real NOT NULL,
  y real NOT NULL,
  UNIQUE (event_id, section, row_label, number)
);
CREATE INDEX IF NOT EXISTS seats_event ON seats (event_id);
CREATE TABLE IF NOT EXISTS seat_sales (
  seat_id uuid PRIMARY KEY REFERENCES seats(id),
  order_id uuid NOT NULL,
  sold_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seat_sales_order ON seat_sales (order_id);
CREATE TABLE IF NOT EXISTS ga_sales (
  order_id uuid NOT NULL,
  tier_id uuid NOT NULL REFERENCES tier_stock(tier_id),
  qty int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, tier_id)
);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  await pool.query(SCHEMA);
  return pool;
}
