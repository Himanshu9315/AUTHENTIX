// pnpm seed: creates (or resets) one fictional gate-staff user for the scanner demo. Dev only.
// Writes to auth's own database because auth-service has no admin API yet (that arrives with the admin dashboard).
import argon2 from "argon2";
import pg from "pg";
import { SCHEMA } from "../src/db.js";

if (process.env.NODE_ENV === "production") throw new Error("seed-staff must not run in production");
const password = process.env.DEMO_STAFF_PASSWORD;
if (!password || password.length < 10 || password.startsWith("change-me")) throw new Error("Set DEMO_STAFF_PASSWORD to a real value (10+ chars, not the .env.example placeholder)");
const url = process.env.DATABASE_URL ?? "postgres://authentix:" + process.env.POSTGRES_PASSWORD + "@127.0.0.1:5432/auth";
if (!process.env.DATABASE_URL && !process.env.POSTGRES_PASSWORD) throw new Error("Set DATABASE_URL, or POSTGRES_PASSWORD for the dev Postgres");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(SCHEMA);
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await client.query(
    `INSERT INTO users (email, name, password_hash, role, email_verified) VALUES ('gate.staff@example.test', 'Demo Gatekeeper', $1, 'staff', true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'staff', email_verified = true`,
    [hash],
  );
  console.log("Seeded staff user gate.staff@example.test");
} finally {
  await client.end();
}
