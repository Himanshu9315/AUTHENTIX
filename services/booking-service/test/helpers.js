import { randomUUID } from "node:crypto";
import pg from "pg";

export const adminUrl = process.env.TEST_PG_URL;
export const skip = adminUrl ? false : "TEST_PG_URL not set (needs the dev Postgres from docker compose)";

export const EVENT_ID = randomUUID();
export const TIER_ID = randomUUID();
export const SEAT_ID = randomUUID();

/** Scratch database per test file, dropped afterwards. */
export async function makeDb() {
  const { createPool } = await import("../src/db.js");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `booking_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

const future = (ms) => new Date(Date.now() + ms).toISOString();

/** In-memory stand-ins for inventory, payment and the eligibility services. Behaviour is switched per test. */
export function makeFakes() {
  const f = {
    cap: 4,
    hotSale: false,
    holderOf: (userId) => `holder-${userId}`, // override to make several accounts share one Aadhaar
    verified: true,
    emailVerified: true,
    holdResult: () => ({ status: 200, json: { ok: true, expiresAt: future(8 * 60_000) } }),
    extendResult: () => ({ status: 200, json: { ok: true } }),
    confirmResult: () => ({ status: 200, json: { ok: true } }),
    calls: { hold: 0, release: 0, confirm: 0, create: [], refund: [], cancel: 0 },
    createReply: null, // set to a function to simulate a lost reply
    payments: new Map(),
  };
  f.clients = {
    getUser: async () => ({ status: 200, json: { name: "Test Person", emailVerified: f.emailVerified } }),
    getHolder: async (userId) => ({ status: 200, json: f.verified ? { verified: true, holderKey: f.holderOf(userId) } : { verified: false } }),
    getEvent: async (id) => ({ status: 200, json: { id, status: "published", startsAt: future(86_400_000), ticketCap: f.cap, hotSale: f.hotSale, tiers: [{ id: TIER_ID, priceInr: 1000 }] } }),
    describeSeats: async (_e, ids) => ({ status: 200, json: { seats: ids.map((id) => ({ id, tierId: TIER_ID, label: "Stalls D-7" })) } }),
    inventory: {
      hold: async (...a) => (f.calls.hold++, f.holdResult(...a)),
      extend: async (...a) => f.extendResult(...a),
      release: async () => (f.calls.release++, { status: 200, json: { ok: true } }),
      confirm: async (...a) => (f.calls.confirm++, f.confirmResult(...a)),
    },
    payment: {
      create: async (key, body) => {
        f.calls.create.push(key);
        const id = randomUUID();
        f.payments.set(id, { id, status: "processing", orderId: body.orderId, key });
        if (f.createReply) return f.createReply(id);
        return { status: 201, json: { id, status: "processing" } };
      },
      byKey: async (key) => {
        const p = [...f.payments.values()].find((x) => x.key === key);
        return p ? { status: 200, json: p } : { status: 404, json: { error: "not_found" } };
      },
      get: async (id) => ({ status: 200, json: f.payments.get(id) }),
      cancel: async (id) => {
        f.calls.cancel++;
        const p = f.payments.get(id);
        if (p.status === "processing") p.status = "cancelled";
        return { status: 200, json: p };
      },
      refund: async (id, key) => {
        f.calls.refund.push(key);
        const p = f.payments.get(id);
        if (p.status !== "succeeded" && p.status !== "refunded") return { status: 409, json: { error: "not_refundable", status: p.status } };
        p.status = "refunded";
        return { status: 200, json: { status: "refunded" } };
      },
    },
  };
  return f;
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, level: "silent" };
