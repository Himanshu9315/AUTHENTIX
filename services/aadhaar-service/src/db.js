import pg from "pg";
import { OUTBOX_DDL } from "@authentix/events";

// The raw Aadhaar number is never stored: only the keyed hash and the last 4 digits for display.
// The UNIQUE constraint on aadhaar_hash is what enforces one Aadhaar, one account.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS aadhaar_verifications (
  user_id uuid PRIMARY KEY,
  aadhaar_hash text NOT NULL UNIQUE,
  last4 char(4) NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otp_sessions (
  user_id uuid PRIMARY KEY,
  txn_id text NOT NULL,
  aadhaar_hash text NOT NULL,
  last4 char(4) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_attempts (
  user_id uuid PRIMARY KEY,
  failed_count int NOT NULL DEFAULT 0,
  locked_until timestamptz
);
CREATE TABLE IF NOT EXISTS anomaly_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  await pool.query(OUTBOX_DDL);
  return pool;
}
