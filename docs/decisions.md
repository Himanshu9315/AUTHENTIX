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

## Phase 5: Tickets, rotating QR, transfers, gate entry

The `architect` agent wrote `docs/phase5-design.md` (full reasoning and SQL). Decisions D39 to D44 below follow it. Where I deviated, it says so.

### D39. The rotating QR: derived secrets, 30-second codes, ticket-service is the only one with the key
- **Chose:** one `QR_MASTER_KEY` in ticket-service. Each ticket's secret is calculated as `HMAC(master, "authentix:qr:v1:" + ticketId + ":" + version)` and never stored. The QR token is 41 bytes (55 characters, so the QR stays small and easy to scan): a format byte, the ticket id, the ticket version, the 30-second step number and a 16-byte signature.
- **Why derived, not stored:** a leaked ticket database cannot be used to make QR codes. Binding the secret to the ticket's `version` means a transfer (version + 1) kills every old code the instant it commits, with nothing to delete or rotate.
- **Why screenshots fail:** a code is accepted only for the current 30-second step and one either side (about 90 seconds at most), entry is one-time, and the gate shows the holder's name. One screenshot sent within 90 seconds could still get one person in. That small risk is accepted for v1.
- **Why the phone gets 5 minutes of codes at once:** the browser fetches the next 10 codes and the server's clock from `GET /tickets/:id/qr`, so a venue with weak signal still works and the secret never reaches the browser. The alternative, fetching every 30 seconds, is stricter but fails in crowds.
- **The signature is checked before expiry,** so a forged code learns nothing about which tickets exist.
- **Revisit:** key rotation (a previous-key setting and a second format byte). If `QR_MASTER_KEY` leaks, every ticket is forgeable.

### D40. Entry is one guarded database update
- **Chose:** admission is a single `UPDATE ... WHERE id, version, event, status = 'active'`. If it changes a row, the scan is green. Otherwise a second query works out why (wrong event, already used, replaced, void).
- **Why:** 20 gates scanning one code at the same moment serialise on that row, so exactly one is admitted. The test fires 20 at once. The same row guard decides a transfer racing a scan: whichever commits first wins.
- **Retries:** each scan has a `scanId`. A scanner that never got an answer resends the same id and gets the same answer. A reused id with a different QR, gate or time is refused (422), so one ticket's green screen can never be replayed for another code. The request fingerprint is a keyed hash, so the QR itself is never stored.
- **Clock handling:** a queued scan is judged at the moment it was captured, if it is under 120 seconds old, so a short network drop doesn't lose people but a late screenshot still fails. A scanner clock running ahead is clamped to the server's time.
- **My deviation:** the design checked "already used" before "version replaced". I check the version first, so an old QR of a ticket that was transferred and then used says "ticket replaced" rather than "already used". It is the clearer message for staff.
- **v1 rules:** no re-entry. Any staff user can scan any event inside the open window. The default window is 6 hours before the start to 12 hours after (D44 covers the demo override).
- **Revisit:** per-event staff assignment (Phase 8), and whether `admin` may scan.

### D41. Tickets are issued by a consumer that is safe to run twice
- **Chose:** ticket-service reads `order.confirmed` from RabbitMQ. Every ticket has a deterministic `issue_key` (`orderId:seatId`, or `orderId:tier:ga:n`), so a redelivered message inserts nothing and emits nothing. Verified by hand: with ticket-service stopped, a confirmed order waited in the queue and its tickets appeared after a restart.
- **The holder's name is a snapshot** ("Asha K.": first name plus last initial) taken when the ticket is issued or transferred. The gate never calls auth, and the full name is never stored in ticket-service.
- **order.refunded is not consumed:** the saga never refunds an order that already reached CONFIRMED, so there are no tickets to void. Organiser cancellation (Phase 8) will need to void tickets and refund.

### D42. A reusable message consumer in `@authentix/events`
- **Chose:** `startConsumer` with a retry queue (a 10-second delay, then back to the main queue) and a parking queue. A failing handler is retried up to 8 times. A permanent error or malformed JSON goes straight to parked. A message is acknowledged only after its parked copy is confirmed, and a failed park puts it back instead of leaving it stuck.
- **Verified live:** with auth-service stopped, a message failed twice and retried every 10 seconds, the ticket was issued after auth came back, and a message for an unknown user was parked.
- **Delivery is at-least-once,** so handlers must be idempotent. The helper does not dedupe.

### D43. Transfers: one transaction for the move, cap moved around it, and a generic refusal
- **The move:** one transaction changes the owner, bumps the version, adds a history row and writes the `ticket.transferred` event. The old QR is dead at commit.
- **Rules (as you approved):** at most 2 transfers per ticket, none within 24 hours of the event, only to a user who is verified on both email and Aadhaar, no price field anywhere, and a transferred ticket counts toward the recipient's per-event cap.
- **Cap order is reserve first, release after:** the recipient's cap is reserved, then the ticket moves, then the sender's share is released. A crash in between can only over-count, so nobody can exceed the cap. A sweeper finishes or reverts anything left half-done. A revert that arrives before its reserve leaves a tombstone, so a late reserve can never apply.
- **No enumeration:** an unknown email, an unverified recipient and a recipient whose cap is full all get the same 422 `recipient_not_eligible`. Known gap: the response time differs slightly between these cases, because they make different numbers of internal calls. I judged that hard to exploit and accepted it.
- **Honest side effect:** a recipient whose cap is full gets the same vague message as a stranger, which can confuse a genuine friend. This was the architect's open question 4 and I kept the privacy.
- **Limits:** the gateway allows 10 transfers per hour per signed-in user. A bug the verifier caught: the rate limiter returned 429 for every request until I fixed its check. The gateway now has a test that would have caught it.
- **Remaining scalper route (Phase 8):** payment for a transfer happens off the platform, and releasing the sender's cap lets one buyer feed tickets to many verified friends. Each recipient's cap still applies. An anomaly flag on outgoing-transfer volume belongs in Phase 8.

### D44. Who may scan: role rules at the gateway, checked again in the service
- **Chose:** the gateway has a small role table (`/api/gate/` needs `staff`) and gate-service checks the role again itself, so a gateway mistake can't open the door. Ticket owners only ever see their own tickets, and anyone else's ticket id is a 404 rather than a 403 so ids can't be probed.
- **Demo staff:** `pnpm seed` creates `gate.staff@example.test` with the password from `DEMO_STAFF_PASSWORD` in `.env`. The script refuses to run in production and has no default password. auth-service has no admin API yet.
- **Demo window:** the real rule is that the gate opens 6 hours before the event, but transfers close 24 hours before, so a demo of "transfer, then the old QR is rejected" can't happen on the real rule. `GATE_OPEN_BEFORE_HOURS` and `GATE_OPEN_AFTER_HOURS` default to 6 and 12 and are widened (2000 hours) only in the git-ignored dev `.env`.

### D45. Phase 5 client decisions
- **Entry code screen:** the code switches every 30 seconds on the server's clock (so a wrong device clock doesn't matter), shows a countdown, tops up its 5-minute batch before it runs out, refreshes when the tab becomes visible again, and notices within 5 seconds if the gate scans the ticket or it is transferred away. Codes live only in memory, never in storage or URLs.
- **Transfer dialog:** two steps (enter, then confirm what happens), one idempotency key held until the server gives a definite answer, and the same vague wording for refusals.
- **My tickets waits for new purchases:** tickets are issued a moment after payment, so an empty list keeps checking for about 30 seconds before saying there are none. I found this by testing with the simulated browser.
- **Scanner:** a separate app (`apps/scanner`, port 8081) that reuses the web app's design tokens. Staff sign in (customer accounts are refused), choose an event and name their gate, and scan with the camera (the browser's `BarcodeDetector`, with `jsQR` as a fallback). Results are a full-screen green ALLOW or red STOP with the reason, and amber when there is no connection. A paste box covers demos and blocked cameras.
- **Offline behaviour:** there is no offline admission, because that would put secrets on staff devices. A scan that can't reach the server is queued with its `scanId` and retried (1, 2, 4, 8 seconds) for up to 2 minutes, then the staff member is asked to rescan. A queued QR is kept in local storage only until there is an answer, it gives up, or the staff member signs out or leaves the screen (they are asked to confirm first, because unsent scans are lost). Leftovers from a closed tab are purged when the app next starts. The staff login is kept in session storage so it is forgotten when the tab closes. A scan that cannot be stored shows a red "Rescan needed" rather than promising a retry.
- **Network trouble is never treated as an answer:** a timeout, a 5xx, a 429, or a failed token refresh makes the scanner queue and retry with the same `scanId`. Only a definite 401/403 from the server ends the shift, and a customer account that signs in by mistake has its session revoked straight away.
- **Event picker:** it lists all upcoming events and the server decides whether the gate is open (`event_not_open`). The design suggested filtering the list to the open window, but the window is configurable on the server (D44), so the client can't know it.
- **Camera needs HTTPS:** `http://localhost:8081` works on a laptop. A phone on the local network would need HTTPS, which I did not set up.
- **How it was tested:** the real apps were driven in a simulated browser against the live stack, and the decoder was checked against a real QR code at full and 40 percent size. **Not tested:** real cameras, real phones, and visual polish. A harness lesson: the simulated browser must create its fake browser before React loads, or typed input silently does nothing.

## Phase 6: The waiting room

Designed on Sonnet only (no `architect`), as you chose. It reuses patterns from earlier phases: signed short-lived tokens, atomic Redis scripts, internal service checks.

### D46. A first-come-first-served line in Redis, one atomic script per action
- **Chose:** queue-service keeps each event's line in a Redis sorted set scored by a **join sequence number** (a counter), not by clock time, so two people joining in the same millisecond still get distinct, strictly ordered places. Joining, checking status, leaving and each admission pass are single Lua scripts, so they are atomic even with several instances. The test has 20 people joining at once and gets places 1 to 20 exactly.
- **Why Redis only:** the line is temporary by nature and needs to be fast. If Redis restarts, everyone simply rejoins. There is no database and no outbox for this service.
- **One place per person:** the line is keyed by user id, so joining twice keeps your original place. One verified person (D8) is one account, so one place.
- **Admission rate:** a worker lets in 10 people every 5 seconds per event (configurable). A Redis lock means several instances don't multiply the rate. The estimated wait is the number of batches ahead times the interval, which is the longest it should take, since people ahead who give up only shorten it.
- **One clock:** every time the queue compares (idle limits, admission expiry, "are they admitted") it uses Redis's own clock, not each service instance's, so instances with slightly different clocks can't disagree. booking-service still checks an admission's expiry against its own clock, which on one machine is the same clock; with servers on different machines you would want them time-synced.
- **A bug the tests caught:** a batch size of 0 would have admitted the whole line, because the Redis range `0..-1` means "everything". It now admits nobody, and the service refuses to start with a batch size below 1.

### D47. The admission token is signed, short-lived, and checked by booking without calling the queue
- **Chose:** when someone reaches the front, queue-service signs a token containing their user id, the event id and an expiry (10 minutes). booking-service checks the signature itself with a secret shared only by those two services, so a booking never needs a call to the queue. For events flagged `hot_sale`, booking refuses an order with no token, a forged token, another person's token, another event's token or an expired token (403), and creates nothing.
- **Deterministic on purpose:** the same user, event and expiry always give the same token, so reloading the page returns the same token and nothing needs to be stored.
- **The signature is checked first,** then expiry, then who and which event, so a forged token learns nothing.
- **A repeated order** (same idempotency key) doesn't need the token again, since the order is already theirs.
- **Fails closed:** if booking has no admission secret configured, hot-sale booking is refused rather than allowed.
- **Known limits:** a token can be used for more than one order until it expires, but the per-Aadhaar ticket cap still bounds what anyone can take. There is also no limit on how many admitted people book at once, only on how fast people are admitted. An admission can't be revoked early, and leaving the queue does not invalidate a token already issued.

### D48. Who may join, and how often
- **Chose:** joining checks that the event is published and flagged hot-sale, and that the person has a confirmed email and a verified Aadhaar. All of it fails closed (503 if a service is down). Unverified accounts therefore can't clog the line. Each person may join up to 20 times a minute, which protects the three services the join check calls.
- **Checking status makes no internal calls:** polling is just Redis, so thousands of waiting people don't load the other services.
- **Honest limit:** the queue is fair between verified people, but it cannot stop one person with a faster connection or a script from joining first. What it does guarantee is one place per verified person.

### D49. How long you can be away: 90 seconds, not the 30 we first agreed
- **Chose:** someone who stops checking in for 90 seconds loses their place. You proposed about 30. I made it 90 because browsers slow down timers in background tabs, so a person who switches tabs for a moment would lose their place, and that would feel unfair. The page also checks in immediately when you come back to the tab. It's one setting (`QUEUE_IDLE_SECONDS`).

### D50. The waiting room in the web app
- **Flow:** on a hot-sale event the main button says "Join the queue", and the page explains the wait. The waiting room shows your place, how many are ahead, the estimated wait and a "Leave the queue" button, and it checks in every 3 to 4 seconds. When admitted it shows a countdown and takes you back to the event page, where booking works and the admission token is sent automatically. A banner counts down the booking time.
- **Errors are handled:** unverified users are sent to verification, a lost connection shows "Reconnecting… your place is safe for a short while", and an expired place or admission offers to rejoin at the back.
- **The token lives in memory only,** and the event page can always get it again from the server, so a reload loses nothing.
- **Your seat choice is not kept** while you wait in line, since you pick tickets after being admitted.
- **How it was tested:** the live stack was exercised through the gateway, and the real app was driven in the simulated browser (sign up, hot event, join, leave, rejoin, admitted, automatic return to the event, book). **Not tested:** many people in the line at once through the real UI, real browser tab throttling, and visual polish.

### D51. The gateway passes JSON bodies through untouched, and the waiting room polls through its own rate-limit bucket
- **The bug:** an empty `DELETE` (or `POST`) that carried a JSON content-type header was rejected by the gateway itself with a 400 before reaching the service. My browser app didn't send that combination, but many HTTP clients do, and the symptom was that "Leave the queue" silently did nothing for them.
- **Fix:** the gateway no longer parses JSON bodies. It never needed to read them, so it forwards the original JSON text and the service validates it. Spacing and non-ASCII characters arrive unchanged (a test checks this). JSON must be UTF-8, so text that isn't valid UTF-8 is not preserved, which is irrelevant for JSON. Re-encoding by the proxy library was the trap on the way: it needs an explicit content-type to send a string as-is.
- **Waiting-room polling has its own bucket:** a request every few seconds per person would otherwise eat the normal 300-a-minute allowance for everyone behind one network address and cause false "Reconnecting…" states. It now has a separate, larger allowance (1200 a minute per address).
- **Also fixed after verification:** the waiting room could end up running two polling loops after "Join again", the join rate limiter could in theory leave a counter that never expired (count and expiry are now one step), and the queue used each server's own clock (now Redis's).
- **Not covered:** an admitted person can book more than once with the same token until it expires, bounded by the Aadhaar ticket cap, and I did not load-test a large crowd.

## Phase 7: Notifications and the help chatbot

The `architect` agent wrote `docs/phase7-design.md`. D52 to D59 record what was built and what I chose on its open questions.

### D52. notification-service: nothing is lost, an inbox entry exists once, an email is sent at most about once
- **What it sends:** verification links; "you're verified"; booking confirmations and refund notices (email and in-app); "tickets are ready" and "email confirmed" (in-app only); and transfer notices to both the receiver and the sender. `user.registered` sends nothing: the verification email is the welcome.
- **Exactly-once inbox:** each inbox row has a unique key, so a redelivered event adds nothing.
- **Near-exactly-once email:** every email is claimed in a `deliveries` table, sent, then marked sent. A crashed worker's claim goes stale after 2 minutes and can be taken over. A failed send releases its claim. The only duplicate window is a crash after the mail server accepted a message but before it was marked sent. Email can't be made exactly-once, so every email carries a fixed Message-ID that mail programs use to collapse duplicates.
- **Retries live on the message broker:** about 30 minutes (90 tries, 20 seconds apart), then parked. This keeps the verification token out of our database entirely. The deliveries table stores no address, no body and no token.
- **Errors are classified:** an unknown person or a bad payload is permanent (parked at once). A down service or a 503 is retried.
- **Hourly cap:** 20 emails an hour per person, then suppressed. A verifier found that this could permanently drop a verification email and strand someone, so verification emails are exempt.
- **No SMS in v1** (your default to confirm): users have no phone number, so there is nothing to send to. A console sink exists for later.
- **Mailpit instead of MailHog:** CLAUDE.md names MailHog. Mailpit is its maintained successor with the same ports, so nothing changes for the demo. Read the mail at http://localhost:8025.
- **Sender notice:** the person who transfers a ticket gets a security email naming the receiver as first name plus initial. They typed the address themselves, so nothing new is revealed.
- **Parked messages** need a manual replay (RabbitMQ management page, "Move messages"). An admin screen for that is Phase 8.

### D53. The emailed verification link keeps its token in the `#fragment`
- **Chose:** `/verify-email#token=...`. A fragment is never sent to a web server, so it can't land in nginx or gateway access logs or in a `Referer` header. The page reads it once, removes it from the address bar straight away, holds it in memory and sends it once (guarded against React's development double-run).
- **States:** confirmed, expired or already used, an incomplete link, and a network error with "Try again". The demo shortcut button on the Verify page still works, because the real email and the shortcut are independent.
- **Notifications in the web app:** a bell with an unread count (polled each minute and when the tab returns), a list that opens from it, and a full `/notifications` page with paging. Links in notifications are checked as same-site paths before they are followed.

### D54. The chatbot: a fixed pipeline, with the model as the last, narrowest step
`personal-data guard -> live-data router -> retrieve -> generate -> output guard`.
- **Personal data is refused, not masked, before anything else:** Aadhaar numbers, VIDs, card numbers that pass the check digit, one-time codes, emails and phone numbers (digits in any script, split by spaces or hyphens). It happens before any logging, embedding or model call, so nothing personal ever reaches Gemini or the logs. Text is first flattened so a number can't be hidden by splitting it: invisible characters (zero-width spaces, soft hyphens) are dropped, every kind of space, tab and newline becomes one space, other scripts' digits become 0-9, and digits separated by spaces, dots, dashes, commas, slashes, colons or brackets are joined. A first version missed several of these (a zero-width space, a comma, a slash, a newline were enough to get a 12-digit number past it) and a reviewer found it, so each way of splitting a number now has its own test. Between two digits, up to three characters that aren't letters or digits (stars, bullets, dashes, brackets, anything) are treated as a separator, and invisible or decorative marks (variation selectors, combining accents) are dropped. A real date standing alone is exempt so it isn't mistaken for a number, but only if no other digits sit next to it, and an impossible date (month 00, day 89) is never exempt: a second review found that a first, looser date exemption let `1000-00-00 0001` through, so those are now tests too.
- **What this guard does NOT promise:** it is a best-effort filter, not a guarantee. It does not catch numbers written out in words, digits separated by letters, or deliberate encodings such as base64, and it errs towards refusing (a list of order numbers such as "1234, 5678, 9012" is refused, and so is a bare "1500"). The system prompt also tells the model never to repeat personal data, and the output guard withholds an answer that contains any. Please treat "nothing personal reaches Gemini" as true for ordinary and for most deliberately disguised numbers, not for every conceivable trick. A turn in the history with such data is dropped silently. Masking was rejected because a masked number can still leak digits. The cost is some false positives, for example a message that is only digits is treated as a possible code, including a bare "1500".
- **Prices, dates and availability are never written by the model.** A plain keyword router spots those questions, finds the event (the page the widget is on, or a whole-title match, never fuzzy), fetches live data from the public catalog and inventory APIs, and answers with a fixed sentence plus structured data that the UI shows. The model isn't called at all. This is more testable, cheaper and safer than letting Gemini call tools. A phrasing it misses just gets a help answer, which can't contain those numbers.
- **Retrieval:** pgvector with an HNSW cosine index, top 4. **The threshold is 0.70, calibrated** on 15 fictional questions with the real embeddings: the lowest answerable question scored 0.759 and the highest unanswerable one 0.644. The design's 0.55 guess would have let off-topic questions through. Below the threshold the bot says "I couldn't find that in our help articles" and doesn't call the model. This is a small sample, so expect to revisit it.
- **Citations come from our own rows,** built from the chunks we actually retrieved, never from what the model writes.

### D55. Defending against hostile event descriptions
Organisers write event descriptions, so they are untrusted text that ends up in a prompt.
- At indexing: Unicode-normalised, invisible and control characters removed, whitespace flattened, `<` and `>` replaced, length capped.
- At question time: sources are wrapped in tags with a trust label, the instruction is a fixed constant (a test checks it is byte-identical), the model has no tools, and the answer is checked afterwards. The check withholds an answer containing personal data, replaces any answer that mentions money, availability, dates or any number of three digits or more (help articles never need one), and removes every link that isn't exactly our own address (a first version only compared the start of the address, so `authentix.in.evil.test` got through; bare domains, `//host`, `javascript:` and markdown links are now removed too). Our own support email address is the one allowed exception.
- **Event chunks contain no prices, dates or stock,** so retrieved text can't be a source for them.
- **Residual risk, accepted:** an organiser can still bias the wording of an answer about their own event. The damaging things (numbers, links, personal data) are blocked in code.

### D56. Gemini details, checked against the SDK and the live API
- **Embedding gotcha:** Gemini Embedding 2 returns ONE combined vector for a list of strings, so each text is wrapped on its own, and the result's shape is verified (the wrong shape is refused and retried later). It has no task type, so the task is written into the text (`task: search result | query: ...`).
- **Model changes are safe:** the index records which model and size built it. On a change at startup, the vectors are dropped and rebuilt, since different models' vectors can't be compared.
- **Thinking:** the model's hidden reasoning is switched off (`thinking_budget=0`) so it doesn't use up the 400-token answer budget. If a model rejects that setting, the call is retried once without it. Timeouts are in milliseconds, confirmed in the SDK.
- **Failures never crash the bot:** a missing key, a 429, a timeout, an empty or blocked answer, or a failed embedding each fall back to showing the best matching help article as written (keyword search over trusted articles only), with a note on why. A 429 isn't retried, and pauses model calls for 30 seconds. A daily limit of 500 model calls guards cost. A failure in the database, the vector search or the model's reply becomes a polite 200 answer with a `degraded` flag (a first version let a database error through as a 500, and a test with a broken database now proves it doesn't).
- **Real smoke test, with your key:** 59 chunks embedded with `gemini-embedding-2` at 768 dimensions, and eight questions asked through the gateway behaved as designed.
- **The key stays out of everything:** read only from the environment, never in logs (logging is whitelist-only and the SDK's own loggers are silenced), tests use a fake and block all non-local network access.

### D57. How the Python checks run
- `scripts/py-venv.sh` creates `services/chatbot-service/.venv` (Python 3.12 where available) and reinstalls only when the requirements change. `scripts/check.sh` runs ruff and pytest from it and reports a **FAIL** if setup breaks, never a silent skip. `check.sh` loads `.env` and runs the pgvector tests when `chatbot-db` is up, and prints a `SKIP` line (never a silent pass) when it isn't. It also now takes a lock, so two runs can't happen at once: the integration tests share a scratch Redis and Postgres that they flush, and a Stop-hook run overlapping a reviewer's run produced confusing failures.
- `docker build --target test -f services/chatbot-service/Dockerfile .` runs the same checks on the image's Python.
- **Contracts can't drift:** `contracts/chatbot.openapi.json` is the source of truth. A test checks every valid and invalid example against both the JSON Schema and the Pydantic models, and compares each model's full definition with the contract (field names, types, allowed values, nullability, size limits, patterns, required fields). A further test proves the comparison isn't vacuous by changing an allowed value, a limit and a nullability and checking each is caught. It found two real mismatches on its first run (`context` and `eventSlug` accepting null), which are now stated in the contract. Every kind of response the service produces (grounded, refused, live data, ambiguous, not found, and each degraded form) is validated against the contract. The models are strict, so `"1499"` is not accepted as a number.

### D58. Network and rate-limit decisions
- **`TRUST_PROXY=true` on the gateway, and its direct port bound to `127.0.0.1`.** Before this, every browser using the web app shared nginx's address and therefore one rate-limit bucket, including the tight login limit and the new chat limit. nginx overwrites `X-Forwarded-For` (it doesn't append), so it can't be spoofed through the web apps. Binding the gateway's own port to localhost means nobody outside this machine can fake an address.
- **Chat:** `POST /api/chat/messages` is the one public POST, in its own bucket (20 a minute per address), with a second limiter inside the service. Everything else under `/api/chat` still needs a sign-in.
- **Help article links** point to the closest existing page, because there is no help page in the web app yet.

### D59. Known gaps for Phase 7
- **Not yet done:** the chat widget in the web app (next), and an automated test for the notification API contract with `ajv` (the Python side is covered).
- **Index freshness:** event chunks refresh every 15 minutes, or on demand through the internal reindex call. Phase 8 admin edits should trigger it.
- **Calibration** used 15 questions; widen it as the knowledge base grows.
- **Not tested:** real Gemini behaviour under sustained load, a 429 from the live API, and the answer quality of the model beyond the eight smoke questions.

### D60. What a reviewer found in the chatbot, and what changed
The verifier's review of Phase 7 produced ten findings. All are fixed, each with a test:
1. **Personal data could be hidden by splitting a number** (zero-width characters, commas, slashes, newlines, tabs, en dashes, brackets, single-spaced digits, other scripts' digits): fixed by flattening the text first (D54).
2. **The link allow-list compared only the start of an address**: fixed by parsing each link and allowing only our exact address (D55).
3. **The output guard missed live-data claims** such as `INR1499`, `sold-out`, "tickets are available", "7 o'clock", "tickets cost 1499": widened, plus any number of three or more digits is blocked in a model answer.
4. **Failures could escape as HTTP 500** (a failing database or vector search, an embedding response with no or wrong-sized vectors): now degraded 200 answers (D56).
5. **The router misread help questions**: "Is there a fee to transfer?" or "How long is the seat hold?" asked "which event?" or showed a live card. Help-topic words now route to the help answer unless the question clearly asks for a price or availability, and two events with the same title (a tour) are now "ambiguous" rather than "unknown".
6. **The per-address limiter could grow without bound,** and a body with no declared length was read in full before the size check. The limiter now forgets idle addresses and is capped, and the body is read as a stream that stops at the limit.
7. **Indexing was fragile:** an empty knowledge folder would have wiped every help article, one chunk Google rejected blocked all later chunks, a malformed catalog row aborted the whole run, and an incomplete catalog read meant waiting 15 minutes to retry. Now an empty folder deletes nothing, rows are retried one by one after a batch failure, a bad event is skipped (and then nothing is deleted), and an incomplete run retries in a minute.
8. **False positives:** "Mark 4 tickets" and "You may 2 transfer" were blocked (month names matched by prefix), a date near the word "code" looked like an OTP, and our own support email was withheld. Fixed.
9. **The contract test was shallower than claimed:** now compares full definitions (D57).
10. **`check.sh` skipped the database tests without saying so,** and the bell could leave an unhandled error on a network failure. Fixed.
- **Calibration after the fixes** is unchanged: the 0.70 threshold depends only on the embeddings.

### D61. A second review round, and the check lock
A second review of the chatbot fixes found more, all now fixed with tests:
- **The date exemption was itself a way round the guard** (see D54) and **more separators were missed** (stars, hashes, semicolons, bullets, variation selectors, combining accents): fixed in D54.
- **The output guard still missed** bare domains with unusual endings (`evil.ru`, `evil[.]test`, `evil . test`), abbreviated or worded figures (`1.5k`, `7p.m.`, `19h`, "tomorrow at 7", "on the 5th", "next Friday", "free tickets", "selling fast", "a few tickets remain", "fifteen hundred"), and compared the support address case-sensitively. Now every bare "name.ending" is removed, those figures are blocked, and the support address is matched in any letter case, as a whole address only ("xsupport@..." is not it).
- **Indexing hammered the catalog every minute when there was no API key,** because rows waiting for embeddings counted as "retry soon". Now only an unreadable catalog shortens the wait, and failures back off 1, 2, 4, ... minutes up to the normal 15.
- **The in-service rate limiter wiped everyone's window** once it tracked 10,000 addresses. It now forgets only the least recently seen address, and a test shows a flood of made-up addresses can't reset a real client's limit.
- **`scripts/check.sh` lock:** my first version could let two runs both take over a dead owner's lock. It now uses a real operating-system file lock (`flock`). It is released the instant its owner ends, however it ends, with no process ids, no stale locks and no race. Tested: runs line up one at a time, and a killed owner hands over immediately.
- **The chat widget** (new): a floating Help button on every page opens an accessible dialog (focus moves in and returns, Escape closes, Tab stays inside, a live-region log), warns not to share personal data, shows citations as links, shows live prices and availability from the API as a card (never from the answer text), notes when it is in fallback mode, sends the event page's slug so "how much is it?" means that event, and keeps only the last six turns in memory. A refused message and its refusal are never sent back as history. Checked in the simulated browser against the real stack: price card, cited help answer, refusal, history, keyboard behaviour.
- **Not covered:** a real screen reader, and the widget on a phone-sized screen.
