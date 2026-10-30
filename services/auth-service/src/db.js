import pg from "pg";
import { OUTBOX_DDL } from "@authentix/events";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'attendee' CHECK (role IN ('attendee','staff','organiser','admin')),
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
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
