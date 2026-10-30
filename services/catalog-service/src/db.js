import pg from "pg";

// Catalog is display data. Stock and seat state belong to inventory-service (Phase 4).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  city text NOT NULL,
  address text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS artists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  image_url text NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('concerts','festivals','comedy')),
  venue_id uuid NOT NULL REFERENCES venues(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  poster_url text NOT NULL,
  hot_sale boolean NOT NULL DEFAULT false,
  verified_entry boolean NOT NULL DEFAULT true,
  ticket_cap int NOT NULL DEFAULT 4 CHECK (ticket_cap BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_browse ON events (status, starts_at);
CREATE TABLE IF NOT EXISTS event_artists (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artists(id),
  PRIMARY KEY (event_id, artist_id)
);
CREATE TABLE IF NOT EXISTS ticket_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_inr int NOT NULL CHECK (price_inr >= 0),
  UNIQUE (event_id, name)
);
`;

/** @param {string} connectionString */
export async function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  return pool;
}
