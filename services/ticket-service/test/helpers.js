import { randomUUID } from "node:crypto";
import pg from "pg";

export const adminUrl = process.env.TEST_PG_URL;
export const skip = adminUrl ? false : "TEST_PG_URL not set (needs the dev Postgres from docker compose)";

/** Scratch database per test file, dropped afterwards. */
export async function makeDb() {
  const { createPool } = await import("../src/db.js");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `ticket_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = await createPool(url.toString());
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}

/** Inserts an active ticket and returns its id. */
export async function insertTicket(pool, { eventId, ownerId = randomUUID(), version = 1, status = "active", seat = null, display = "Asha K." } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tickets (issue_key, order_id, event_id, tier_id, seat_id, seat_label, owner_user_id, holder_display, version, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [randomUUID(), randomUUID(), eventId, randomUUID(), seat, seat ? "Stalls D-7" : null, ownerId, display, version, status],
  );
  return rows[0].id;
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, level: "silent" };
