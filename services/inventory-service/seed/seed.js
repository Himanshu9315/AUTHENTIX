// Loads fictional stock for the catalog's events. Run after the catalog seed (pnpm seed does both).
// Event and tier ids come from the public catalog API, so inventory never reads catalog's tables.
// Idempotent: upserts by tier id and by (event, section, row, number); never resets `sold`.
import pg from "pg";
import { SCHEMA } from "../src/db.js";
import { seatedEvents } from "./layout.js";

const gateway = process.env.GATEWAY_URL ?? "http://localhost:3000";
const url = process.env.DATABASE_URL ?? "postgres://authentix:" + process.env.POSTGRES_PASSWORD + "@127.0.0.1:5432/inventory";
if (!process.env.DATABASE_URL && !process.env.POSTGRES_PASSWORD) throw new Error("Set DATABASE_URL, or POSTGRES_PASSWORD for the dev Postgres");

const get = async (path) => {
  const res = await fetch(gateway + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

const { items } = await get("/api/catalog/events?limit=50");
const client = new pg.Client({ connectionString: url });
await client.connect();
let seatCount = 0;
try {
  await client.query(SCHEMA);
  await client.query("BEGIN");
  for (const summary of items) {
    const e = await get(`/api/catalog/events/${summary.slug}`);
    const layout = seatedEvents[e.slug];
    const tierId = Object.fromEntries(e.tiers.map((t) => [t.name, t.id]));

    const seatMap = layout ? { viewBox: layout.viewBox, stage: layout.stage, sections: layout.sections.map((s) => ({ name: s.name, tierId: tierId[s.tier] })) } : null;
    await client.query(
      "INSERT INTO event_inventory (event_id, seat_map) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET seat_map = EXCLUDED.seat_map",
      [e.id, seatMap],
    );

    if (layout) {
      for (const section of layout.sections) {
        const tid = tierId[section.tier];
        if (!tid) throw new Error(`${e.slug}: no catalog tier named ${section.tier}`);
        await client.query(
          `INSERT INTO tier_stock (tier_id, event_id, kind, capacity) VALUES ($1, $2, 'seated', $3)
           ON CONFLICT (tier_id) DO UPDATE SET capacity = EXCLUDED.capacity`,
          [tid, e.id, section.seats.length],
        );
        for (const s of section.seats) {
          await client.query(
            `INSERT INTO seats (event_id, tier_id, section, row_label, number, x, y) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (event_id, section, row_label, number) DO UPDATE SET tier_id = EXCLUDED.tier_id, x = EXCLUDED.x, y = EXCLUDED.y`,
            [e.id, tid, section.name, s.row, s.number, s.x, s.y],
          );
          seatCount++;
        }
      }
    } else {
      // Hot-sale events get small stock so sell-outs and the queue are easy to demo.
      for (const [i, t] of e.tiers.entries()) {
        const capacity = Math.max(10, Math.round((e.hotSale ? 60 : 300) / (i + 1)));
        await client.query(
          `INSERT INTO tier_stock (tier_id, event_id, kind, capacity) VALUES ($1, $2, 'ga', $3)
           ON CONFLICT (tier_id) DO UPDATE SET capacity = GREATEST(EXCLUDED.capacity, tier_stock.sold)`,
          [t.id, e.id, capacity],
        );
      }
    }
  }
  await client.query("COMMIT");
  console.log(`Inventory seeded for ${items.length} events (${seatCount} seats).`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end();
}
