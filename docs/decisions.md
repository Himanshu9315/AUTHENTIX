# Authentix decisions log

Read this after the project to see why things are the way they are. Each entry says what we chose, why, what we gave up, and when to revisit it. New decisions are appended per phase. Phase 1 entries were reconstructed from the code and commit, so their reasoning is inferred rather than recorded at the time.

---

## Phase 1: Foundation

### D1. One database per service, one Postgres server
- **Chose:** a single Postgres container with a separate database per service (`auth`, `aadhaar`, ...), created by `infra/postgres/init.sql`.
- **Why:** CLAUDE.md forbids one service reading another's tables. Separate databases make that physically impossible, and running one server keeps `docker compose up` light.
- **Gave up:** cross-service joins. Services share data through events or API calls only.
- **Note:** `init.sql` runs only on a fresh volume. On an existing volume, create new databases by hand (I did this for `aadhaar`).

### D2. Events use the outbox pattern (`@authentix/events`)
- **Chose:** a service writes the event to an `outbox` table in the same transaction as its data change. A relay polls the table and publishes to RabbitMQ (topic exchange `authentix.events`).
- **Why:** it avoids lost events (data saved, publish failed) and phantom events (published, transaction rolled back).
- **Gave up:** a ~1s delay, and delivery is at-least-once, so consumers must dedupe on `messageId`.

### D3. The gateway is the only place JWTs are verified
- **Chose:** the gateway verifies the access token and forwards `x-user-id` and `x-user-role`. It deletes any client-supplied versions of those headers first. Services trust the headers.
- **Why:** one place for auth logic, and services stay simple.
- **Trade-off:** services must never be reachable except through the gateway. Compose publishes only the gateway's port (plus the dev-only Postgres port, see D14).
- **Also:** the gateway generates request IDs itself and ignores client-supplied ones, so a client cannot forge trace IDs.

### D4. Auth tokens: short JWT plus rotating opaque refresh token
- **Chose:** a 15 minute HS256 access JWT (issuer and audience checked), and a random refresh token stored only as a SHA-256 hash, rotated on every use. Passwords use argon2id.
- **Why:** a stolen access token dies quickly. Hashing refresh tokens means a database leak does not yield usable tokens.
- **Login timing:** an unknown email is checked against a dummy hash, so response time does not reveal which emails exist.
- **Revisit:** HS256 means the gateway and auth-service share a secret. Move to RS256 if more services ever need to verify tokens independently.

## Phase 1 gap fixes

### D5. Refresh-token families
- **Chose:** every login starts a `family_id`. Rotation keeps it. If an already-revoked token is presented again, the whole family is revoked.
- **Why:** a revoked token showing up again means it was stolen or replayed. Killing the family logs out the thief and the real user, who simply logs in again. This is the standard refresh-token reuse-detection approach.
- **Detail:** the lookup uses `SELECT ... FOR UPDATE`, so two simultaneous refreshes with the same token cannot both succeed.

### D6. Email verification tokens leave only through the outbox
- **Chose:** a random one-time token, stored hashed, valid 24h. The plaintext goes out only in the `user.email_verification_requested` event, for notification-service to email in Phase 7.
- **Dev shortcut:** with `DEV_EXPOSE_VERIFICATION_TOKEN=true` the token is also returned in the API response, so the flow can be demoed before notification-service exists. It is off by default in compose.
- **Gave up:** the token sits in plaintext in the outbox row and the broker message for a short time. Acceptable for a mock; notification-service must never log it.

### D7. Rate limiting moved to Redis, and fails open
- **Chose:** `@fastify/rate-limit` backed by Redis, falling back to in-memory when `REDIS_URL` is unset. If Redis is down, requests are allowed.
- **Why:** the in-memory limiter resets on restart and is per-instance. Failing open keeps the site up if Redis blips.
- **Trade-off:** during a Redis outage, brute-force protection on login is off. For a real launch, consider failing closed on the auth routes only.

## Phase 2: Identity

### D8. Aadhaar is hashed with a keyed hash and no per-user salt
- **Chose:** `HMAC-SHA256(AADHAAR_HASH_SECRET, number)`. Only the hash and the last 4 digits are stored. The raw number never reaches a table, the outbox, or the logs.
- **Why no per-user salt:** "one Aadhaar = one account" needs the same number to always give the same hash so a unique constraint can catch it. A per-user salt would make every hash different and break that. The server-side secret does the protecting instead: Aadhaar has only 12 digits, so a plain hash could be brute-forced, but an HMAC cannot without the secret.
- **Trade-off:** losing or changing the secret orphans every stored hash, so it needs backing up like a database key.
- **Test:** `services/aadhaar-service/test/uniqueness.test.js` scans every table for the raw number.

### D9. The database unique constraint is the source of truth for uniqueness
- **Chose:** `UNIQUE (aadhaar_hash)` plus catching error `23505`, rather than "check, then insert".
- **Why:** check-then-insert has a race: two accounts verify the same number at once and both pass the check. The constraint lets exactly one commit. The test fires 10 concurrent verifies and expects 1 winner.

### D10. Duplicate Aadhaar is revealed only after the OTP is proven
- **Chose:** `/aadhaar/otp` does not check whether the number is already linked. Only `/aadhaar/verify` does, after a correct OTP.
- **Why:** checking at OTP time would let anyone probe which Aadhaar numbers are registered. After a correct OTP, the user has proven they control that number, so telling them it is taken leaks nothing.

### D11. The number is dropped after the OTP request
- **Chose:** at OTP time we store the hash, last 4 digits and mock transaction ID in `otp_sessions` for 10 minutes. The user sends only the OTP when verifying.
- **Why:** the full number is held in memory for one request and never written anywhere.

### D12. Failed-OTP lockout lives in Postgres, per user
- **Chose:** 5 wrong OTPs lock the user out for 15 minutes, counted by an atomic upsert. Each lockout and each duplicate-Aadhaar attempt adds a row to `anomaly_flags`.
- **Why:** Phase 1's Redis limiter is per IP, but this rule is per account. Postgres keeps the count correct under parallel guesses, and the flag rows feed the Phase 8 admin dashboard. CLAUDE.md says to flag, not auto-ban, so the lock is temporary.
- **Known edge:** a request already in flight when the lock fires can leave the counter at 1 after the lock expires. Negligible.

### D13. mock-uidai design
- **Chose:** a separate container with a seed list of fictional numbers that all start with 0 or 1.
- **Why:** real Aadhaar numbers never start with 0 or 1, so a seed number can never be someone's real number. It also has an outage number (503) and a slow number (4s) to exercise the retry and timeout paths, and it refuses to start when `NODE_ENV=production`.
- **Detail:** the mock allows 5 wrong OTPs per transaction, matching our lockout. At 3 its transactions died first and our lockout never fired.
- **Simplification:** the real eKYC API returns name and date of birth. The mock returns only `verified: true`. The ticket-holder name comes from the user's account instead, so no Aadhaar demographic data is handled.

### D14. Dev conveniences that must not ship
- Postgres is published on `127.0.0.1:5432` so the integration tests can reach it.
- `DEV_EXPOSE_VERIFICATION_TOKEN` returns email tokens in responses.
- The mock OTP is fixed at `123456`.
- `scripts/check.sh` runs the Postgres tests when it finds the dev Postgres, and they skip with a message when it is not running.

### D15. Tests only where CLAUDE.md asked
- Only the Aadhaar uniqueness test exists so far. The per-event cap half comes with booking-service in Phase 4. Lockout and UIDAI retry paths were checked by hand against the running stack, not by automated tests.

### D16. No `architect` subagent so far
- Nothing in Phases 1 and 2 needed it. The hash design (D8) was the closest call, and I judged it routine. It will be used for the seat-hold and booking-saga work in Phase 4.

## Phase 3: Catalog and web shell

### D17. Design tokens were read from district.in's CSS, not guessed
- **Chose:** Claude in Chrome wasn't available, so I downloaded the three stylesheets District serves and read its CSS variables directly: type scale, 4px spacing scale, radii, the grey scale, and the light/dark surface roles. They live in `apps/web/src/design/tokens.js`, and the Tailwind config generates the light and dark CSS variables from that file, so there is one source of truth.
- **Why:** CLAUDE.md says "do not guess values". Real variable values are more exact than eyeballing a screenshot.
- **Not copied:** District's purple brand colour, its PassengerSerif font (licensed), and any images, text or code. Authentix has its own teal brand (`#0c7c70`, passes 4.5:1 on white) and uses Be Vietnam Pro (open licence, loaded from Google Fonts).
- **Deviation:** District's `grey-400` (#77777e) fails WCAG AA as small text on the light secondary background (3.9:1), so light-theme tertiary text uses `#65656c` instead.
- **Limit:** layout measurements (card width, header height, carousel gap) are my approximations in the District style. I couldn't render their pages to measure them.

### D18. Catalog holds display data only
- **Chose:** catalog-service has venues, artists, events and ticket tiers (name, description, price). It does not hold stock or seat state.
- **Why:** inventory-service owns what is sold or held (Phase 4), and a service must not own another's data. The catalog shows tiers; inventory will say how many are left.
- **Also:** `hot_sale`, `verified_entry` and `ticket_cap` (default 4) are on the event so the queue, the badge and the booking cap have one place to read from.

### D19. Catalog reads are public; organiser writes wait for Phase 8
- **Chose:** `GET /api/catalog/*` needs no login and keeps the normal rate-limit bucket. The strict bucket is for login and registration only. Anything other than GET on `/api/catalog` still needs a JWT. The gateway still strips client-supplied identity headers.
- **Why:** browsing must work before sign-up. Create and edit endpoints belong with the admin dashboard, so I didn't build them early. The seed script writes to the database directly.

### D20. Search is plain `ILIKE`, with wildcards escaped
- **Chose:** one `q` filter matches event title, venue name or artist name. `%` and `_` in user input are escaped, so a search for `%` doesn't match everything.
- **Gave up:** ranking and typo tolerance. Postgres full-text search or `pg_trgm` is the upgrade if needed. At 18 events it isn't.

### D21. Distance is computed in SQL from the user's coordinates
- **Chose:** the client sends `lat` and `lng`, and the API returns `distanceKm` using the spherical law of cosines. The coordinates come from the selected city's centre, or from the browser's location if the user opts in.
- **Why:** the card must show distance. Using the city centre by default avoids asking for location permission on first visit.

### D22. Seed data is fully fictional and generated
- **Chose:** 18 events, 6 venues and 20 artists, all invented (for example "Captain Chutney"). Posters and avatars are SVGs generated from the title, with no third-party images. Dates are "today plus N days", so the demo never goes stale, and the seed is idempotent (upserts by slug).
- **Known gap:** re-seeding doesn't delete ticket tiers removed from the seed file.

### D23. Frontend stack and a deliberately simple data layer
- **Chose:** React + Vite + Tailwind v3, React Router, and a small `useFetch` hook. No state or data-fetching library.
- **Why:** three read-only pages don't need one. Tailwind v3 was chosen over v4 because v3's `tailwind.config.js` takes the JS token file directly.
- **Dev vs Docker:** in dev, Vite proxies `/api` to the gateway. In Docker, nginx serves the build on port 8080 and proxies `/api` to the gateway. Both are same-origin, so no CORS setup is needed.

### D24. "Book tickets" is honest about not working yet
- **Chose:** the sticky button scrolls to the ticket tiers and shows "Checkout isn't available in this build yet." Real checkout arrives in Phase 4.
- **Placeholders:** footer social, help and legal links point at placeholders until those pages exist.

### D25. How the web app was verified
- **Chose:** `vite build`, then a one-off server-side render of each route (home, search, event detail, 404) to catch runtime errors (run by hand, not kept in the repo), plus HTTP checks against the running nginx and gateway.
- **Gap:** I couldn't look at the pages in a browser, so visual polish, spacing and the District feel are unreviewed. Open `http://localhost:8080` and judge them yourself.
