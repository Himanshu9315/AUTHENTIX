import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.LOG_LEVEL = "silent";
const adminUrl = process.env.TEST_PG_URL;
const skip = adminUrl ? false : "TEST_PG_URL not set (needs the dev Postgres from docker compose)";

const SECRET = "test-secret-test-secret-test-secret-0123";
const NUMBER = "100000000001"; // fictional: real Aadhaar numbers never start with 0 or 1
const OTHER = "100000000002";
const fakeUidai = { sendOtp: async () => ({ txnId: "txn" }), verifyOtp: async () => ({ verified: true }) };

describe("aadhaar uniqueness", { skip }, () => {
  const dbName = `aadhaar_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin, pool, app;

  before(async () => {
    const { createLogger } = await import("@authentix/logger");
    const { createPool } = await import("../src/db.js");
    const { buildApp } = await import("../src/app.js");
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    pool = await createPool(url.toString());
    app = await buildApp({ pool, logger: createLogger("test"), uidai: fakeUidai, config: { hashSecret: SECRET } });
  });

  after(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  // Runs the full OTP + verify flow for a fresh user and returns the verify status code.
  async function verifyNewUser(aadhaar) {
    const headers = { "x-user-id": randomUUID() };
    const otp = await app.inject({ method: "POST", url: "/aadhaar/otp", headers, payload: { aadhaar } });
    assert.equal(otp.statusCode, 202);
    const res = await app.inject({ method: "POST", url: "/aadhaar/verify", headers, payload: { otp: "123456" } });
    return { status: res.statusCode, error: res.json().error, userId: headers["x-user-id"] };
  }

  test("a second account cannot verify with an Aadhaar that is already linked", async () => {
    assert.equal((await verifyNewUser(NUMBER)).status, 200);
    const second = await verifyNewUser(NUMBER);
    assert.equal(second.status, 409);
    assert.equal(second.error, "aadhaar_already_linked");
    const flags = await pool.query("SELECT kind FROM anomaly_flags WHERE user_id = $1", [second.userId]);
    assert.deepEqual(flags.rows.map((r) => r.kind), ["duplicate_aadhaar_attempt"]);
    assert.equal((await verifyNewUser(OTHER)).status, 200);
  });

  test("concurrent verifications of one Aadhaar produce exactly one winner", async () => {
    const number = "100000000003";
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyNewUser(number)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 9);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM aadhaar_verifications WHERE last4 = '0003'");
    assert.equal(rows[0].n, 1);
  });

  test("a verified user emits one user.verified event and the raw number is never stored", async () => {
    const { rows: events } = await pool.query("SELECT payload FROM outbox WHERE type = 'user.verified'");
    assert.ok(events.length >= 3);
    for (const e of events) assert.deepEqual(Object.keys(e.payload).sort(), ["userId", "verifiedAt"]);
    for (const table of ["aadhaar_verifications", "otp_sessions", "anomaly_flags", "outbox"]) {
      const { rows } = await pool.query(`SELECT t::text AS row FROM ${table} t`);
      for (const r of rows) assert.doesNotMatch(r.row, /\b1000000000\d\d\b/);
    }
  });
});
