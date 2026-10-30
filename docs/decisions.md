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

## Phase 4: Inventory, booking and payments

The `architect` agent (Opus) wrote the design note `docs/phase4-design.md`, with the full reasoning and SQL. This section records the decisions and what I chose on its open questions.

### D26. Postgres is the only guarantee against double-selling; Redis holds are a convenience
- **Chose:** a seat sale is a Postgres insert into `seat_sales` with `seat_id` as the primary key, so the database physically refuses a second sale. General-admission stock has `CHECK (sold <= capacity)` plus a guarded `UPDATE`. Holds (the 8-minute "reserved while you pay" state) live in Redis with a TTL.
- **Why:** if Redis restarts and forgets every hold, the worst outcome is a buyer who paid gets a refund. It can never produce two tickets for one seat. The race test proves this by wiping Redis and letting 50 buyers confirm the same seat: exactly one wins.
- **Why not `SELECT ... FOR UPDATE SKIP LOCKED` for seats:** that suits "give me any free seat". We sell specific seats, and a primary-key constraint is a simpler and stronger guarantee. `SKIP LOCKED` is used in the booking sweeper instead.
- **Hold steps:** take the Redis hold first, then check Postgres for sold seats. The reverse order has a window where a seat sells between the check and the hold.

### D27. Inventory stores stock, never prices
- **Chose:** prices stay in catalog and booking reads them at order time. Inventory learns about events and tiers by calling the public catalog API in its seed.
- **Why:** one source of truth for price, and no cross-service table reads.
- **Revisit:** in Phase 8, catalog should emit events when an organiser edits an event, and inventory should consume them.

### D28. The booking saga is a state machine with guarded updates and a sweeper
- **States:** PENDING, HELD, PAYMENT_PENDING, PAID, CONFIRMED, plus the endings FAILED, CANCELLED, EXPIRED and REFUND_PENDING, REFUNDED.
- **Chose:** every change is `UPDATE ... WHERE state = expected`. If 0 rows change, someone else already moved the order. This lets the request handler, the payment callback and the sweeper race safely with no locks held across HTTP calls.
- **Sweeper:** every 5 seconds it leases orders with `FOR UPDATE SKIP LOCKED`, commits, then does the HTTP work. It handles lost callbacks, crashes between steps and expired holds.
- **Why not distributed transactions:** CLAUDE.md rules them out. Compensation (release the hold, refund) replaces them.
- **Callbacks only affect the current attempt:** a callback is matched to the payment recorded for the order's latest attempt, so a late or repeated callback from attempt 1 cannot disturb attempt 2.
- **Retry backoff:** a dependency that is down is retried after 5 s, 15 s, 45 s, 135 s, then every 5 minutes.
- **Tested paths:** declined payment, hold expiry, payment succeeds but seats are gone (refund), crash while PAID, crash while REFUND_PENDING, a hanging payment, a late success after the order failed, a lost create reply (found by key, and never created), a second charge, duplicate and concurrent callbacks, seats lost while extending the hold, an unsupported instrument, a hold request that never answered, two sweepers at once, and the signed callback route (valid, bad signature, stale timestamp, tampered body, non-ASCII header).

### D29. Money is never silently kept
- **Chose:** if a payment succeeds after its order already failed, expired or was cancelled, the order moves to REFUND_PENDING and is refunded (reason `late_payment`). If the customer pays but the seats were lost in the meantime, they are refunded too.
- **Why:** the alternative is a customer charged for nothing. A refund costs nothing in a mock and is the correct real-world behaviour.

### D30. Idempotency uses natural keys, not a generic key table
- **Chose:** `UNIQUE (user_id, idempotency_key)` on orders and `UNIQUE (order_id, idempotency_key)` on payment attempts. A repeated key with the same body returns the order's current state. A repeated key with a different body gives 422. Booking derives the payment keys itself (`pay:{orderId}:{attempt}`, `refund:{paymentId}`) so a retried call can never charge twice.
- **Trade-off:** a replay returns the current state, not a byte-identical copy of the first response.
- **The pay-key hash includes the instrument:** it is a keyed HMAC over the method plus the card's last 4 digits (or the UPI id), so reusing a key with a different card gives 422. It is not reversible without the server secret and the full card number is never part of it.
- **A bug the tests caught:** two simultaneous pay requests with the same key made the second fail with `invalid_state`. It now returns the current state.

### D31. The per-Aadhaar ticket cap is reserved atomically, with a derived key
- **Chose:** `cap_usage(event_id, holder_key, qty)` is updated with `INSERT ... ON CONFLICT DO UPDATE ... WHERE qty + new <= cap` in the same transaction as the order insert. The row lock serialises parallel orders by one person. In-flight orders count, and the share is released exactly once (a `cap_held` flag) when an order ends without tickets.
- **holderKey, not the hash:** aadhaar-service gives booking `HMAC(secret, "holder:v1:" + hash)`. The uniqueness hash never leaves aadhaar-service, so a leaked booking database cannot be joined to the Aadhaar database.
- **Test:** 10 parallel orders on one Aadhaar with a cap of 4 gives exactly 4.

### D32. Eligibility fails closed
- **Chose:** booking asks auth-service (email verified) and aadhaar-service (Aadhaar verified) on every new order. If either is down, booking returns 503 rather than guessing.
- **Why:** the JWT carries only the user id and role, so it can't say whether someone is verified, and anything cached would go stale.

### D33. Internal routes are protected twice
- **Chose:** `/internal/*` routes need an `x-internal-token` (constant-time compare). The gateway also strips that header from clients and returns 404 for any path containing `/internal` or `..`, decoding repeatedly so `%252e` tricks fail. payment-service is not routed by the gateway at all.
- **Why two layers:** the gateway forwards the URL as-is, so one missed encoding would otherwise expose an internal route. A verifier review caught the double-encoding gap.

### D34. Payment mock details
- **Chose:** outcomes come from fictional test instruments (`4242...` succeeds, `...0002` declines, `...9999` hangs, `...0077` succeeds after 20 seconds, UPI `success@`, `fail@`, `timeout@authentix`). Card numbers, CVCs and UPI ids are never stored or logged. Delayed outcomes are stored in the database and applied by a 1-second poller, so a restart loses nothing.
- **Callbacks:** payment-service writes the callback in the same transaction as the status change and delivers it signed (HMAC over timestamp + raw body) with retries. Booking rejects bad signatures and timestamps more than 5 minutes off.
- **No re-charge after a lost reply:** booking never keeps card details, so it cannot re-send a create call. Instead the sweeper asks payment-service for the payment by its derived key (`pay:{orderId}:{attempt}`). If it exists, the order adopts it and carries on. If it does not, nothing was charged and the order goes back to HELD.
- **Stray charges are refunded:** a successful payment that is not the order's current one (a second charge, or an old attempt) is refunded straight away. If that refund call itself fails it is only logged for follow-up. A durable retry table for strays is a known gap.

### D35. Answers to the architect's open questions
1. **A live hold beats an expired paid order**, and the payer is refunded. Respecting holds keeps the rule simple: whoever currently holds a seat keeps it.
2. **Hot-sale events are bookable now.** The queue and admission token come in Phase 6, which will add the gate.
3. **Transfers and the recipient's cap:** not counted yet. Decide in Phase 5 with the transfer rules.
4. **Price is read live from catalog when the order is created.** Existing orders keep their price.
5. **Three payment attempts per order** while the hold is valid.

### D36. Test strategy for this phase
- `services/inventory-service/test/race.test.js`: 50 buyers on one seat (one winner), multi-seat holds are all-or-nothing, Redis wiped with the fence off (Postgres alone allows one sale), idempotent confirm even when a competing hold touched the seat, a failed confirm releases its fence, and GA sells exactly its capacity.
- `services/booking-service/test/cap.test.js` and `saga.test.js` (5 + 20 tests): the cap race and the failure paths above, against a real Postgres with fake inventory and payment clients. Not covered by automated tests: the real HTTP between services (checked by hand with an end-to-end run through the gateway) and the stray-refund failure case.
- Tests use scratch databases, and Redis logical DB 15 only, which is flushed. The dev data in DB 0 is never touched.

### D37. A wrong OTP is 422, and the web client only retries on the gateway's own 401
- **Bug found by driving the real UI:** aadhaar-service answered a wrong OTP with HTTP 401. The web client treats 401 as "access token expired", refreshes it and retries the request, so every wrong OTP used two of the five attempts.
- **Fix, both sides:** a wrong OTP is now 422, and the client only refreshes and retries when the body is the gateway's `{"error":"unauthorized"}`. 401 stays reserved for "not signed in".

### D38. Web checkout decisions
- **Sign-in:** the refresh token is kept in `localStorage` so a reload keeps you signed in, and the 15-minute access token stays in memory only. Trade-off: script injected into the page could read the refresh token. An `HttpOnly` cookie would be safer but needs gateway changes, and it is on the revisit list.
- **Idempotency keys follow the request, not the click:** booking and paying each keep one key until the server gives a definite answer, and a new key starts when the selection changes. A 503, a timeout or a network error keeps the key, so pressing the button again returns the same order or payment. An in-flight guard stops a fast double-click from sending two requests. A definite 4xx answer clears the key. If the card details change while a key is still held, the server answers 422 and the page tells the user to press Pay again.
- **Server time decides the countdown:** the checkout timer uses the server's `serverTime` to correct a wrong clock on the device, and when it reaches zero the page asks the server rather than deciding the hold is over.
- **Card details:** the form is cleared the moment the payment request is built, so a decline or error means retyping (or tapping a test card). Card numbers never go into storage, logs or URLs. Only fictional test cards are accepted.
- **Demo hints are a build flag:** the test-card buttons and the "demo OTP is 123456" text only appear in dev builds or when `VITE_DEMO_HINTS=true` (the Docker image sets it to true for the demo). Turn it off for anything public.
- **Sessions survive blips:** a 5xx or restart during token refresh no longer signs the user out. Only a 401 or 403 does, and a refresh that finishes after sign-out is discarded.
- **Safe `?next=`:** redirects only go to same-origin paths, checked by parsing against our own origin, which also catches backslash and tab tricks.
- **Checkout resilience:** only the newest response updates the page, an error shows a retry instead of loading forever, and once the hold hits zero the page keeps polling until the server says what happened. Cancel and Pay disable each other.
- **Keyboard and screen readers:** seats use arrow keys with one tab stop, selected seats show a check mark as well as a colour, and the selected count and the one-minute warning are announced. Payment methods are real radio buttons. Not tested with a real screen reader.
- **Demo shortcut for email:** until notification-service sends real emails (Phase 7), the verification page shows a "Confirm my email" button when the dev flag returns the token. It does not appear in any other configuration.
- **Resume:** a banner on every page offers "Resume checkout" while an unpaid order is still held, using `GET /booking/orders?active=true`.
- **How it was tested:** the real app was driven in a simulated browser (jsdom) against the live stack: register, confirm email, a wrong then a right OTP, pick seats on the map, book, a declined card, retry, confirmation, sold seats on the map, the general-admission stepper stopping at the cap, resume banner, cancel. This found the 401 bug in D37. **Not tested:** real browsers, layout and visual polish, and keyboard use beyond the seat buttons being focusable.
- **Placeholders left:** "My tickets" and the rotating QR arrive in Phase 5, and the footer's help and legal links are still placeholders.
- **StrictMode lesson:** an early version of checkout stored an "unmounted" flag that stayed true under React StrictMode's dev-only mount, cleanup, mount sequence, which left the page loading forever in `pnpm dev` but not in the production build. A verifier caught it. The simulated-browser test now renders under StrictMode so dev and production behave the same.
- **Seat focus:** a seat's focus ring is a thicker stroke plus an SVG outline, because the usual box-shadow ring does not draw on SVG.
