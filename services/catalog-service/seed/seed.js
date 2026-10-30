// pnpm seed: loads fictional venues, artists, events and ticket tiers, and writes placeholder art
// into apps/web/public. Safe to re-run: rows are upserted by slug and dates move to "now + N days".
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { SCHEMA } from "../src/db.js";
import { artists, events, venues } from "./data.js";
import { avatarSvg, posterSvg } from "./art.js";

const url = process.env.DATABASE_URL ?? "postgres://authentix:" + process.env.POSTGRES_PASSWORD + "@127.0.0.1:5432/catalog";
if (!process.env.DATABASE_URL && !process.env.POSTGRES_PASSWORD) throw new Error("Set DATABASE_URL, or POSTGRES_PASSWORD for the dev Postgres");

const publicDir = new URL("../../../apps/web/public/", import.meta.url);
mkdirSync(new URL("posters/", publicDir), { recursive: true });
mkdirSync(new URL("artists/", publicDir), { recursive: true });

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(SCHEMA);
  await client.query("BEGIN");

  const venueIds = {};
  for (const v of venues) {
    const { rows } = await client.query(
      `INSERT INTO venues (slug, name, city, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, address = EXCLUDED.address, lat = EXCLUDED.lat, lng = EXCLUDED.lng
       RETURNING id`,
      [v.slug, v.name, v.city, v.address, v.lat, v.lng],
    );
    venueIds[v.slug] = rows[0].id;
  }

  const artistIds = {};
  for (const a of artists) {
    writeFileSync(new URL(`artists/${a.slug}.svg`, publicDir), avatarSvg(a.name));
    const { rows } = await client.query(
      `INSERT INTO artists (slug, name, image_url) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url RETURNING id`,
      [a.slug, a.name, `/artists/${a.slug}.svg`],
    );
    artistIds[a.name] = rows[0].id;
  }

  for (const e of events) {
    writeFileSync(new URL(`posters/${e.slug}.svg`, publicDir), posterSvg(e.title, e.category));
    // Start time is "today + day" at e.hour IST (UTC+5:30).
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + e.day);
    start.setUTCMinutes(e.hour * 60 - 330);
    const end = new Date(start.getTime() + e.hours * 3_600_000);
    const { rows } = await client.query(
      `INSERT INTO events (slug, title, description, category, venue_id, starts_at, ends_at, poster_url, hot_sale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, category = EXCLUDED.category,
         venue_id = EXCLUDED.venue_id, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, poster_url = EXCLUDED.poster_url, hot_sale = EXCLUDED.hot_sale
       RETURNING id`,
      [e.slug, e.title, e.description, e.category, venueIds[e.venue], start, end, `/posters/${e.slug}.svg`, e.hot],
    );
    const id = rows[0].id;
    await client.query("DELETE FROM event_artists WHERE event_id = $1", [id]);
    for (const name of e.artists) {
      await client.query("INSERT INTO event_artists (event_id, artist_id) VALUES ($1, $2)", [id, artistIds[name]]);
    }
    for (const t of e.tiers) {
      await client.query(
        `INSERT INTO ticket_tiers (event_id, name, description, price_inr) VALUES ($1,$2,$3,$4)
         ON CONFLICT (event_id, name) DO UPDATE SET description = EXCLUDED.description, price_inr = EXCLUDED.price_inr`,
        [id, t.name, t.description, t.price],
      );
    }
  }
  await client.query("COMMIT");
  console.log(`Seeded ${venues.length} venues, ${artists.length} artists, ${events.length} events.`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end();
}
