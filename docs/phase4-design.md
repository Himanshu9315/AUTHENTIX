# Phase 4 design: inventory, booking saga, mock payments

Status: proposed (architect). Implementer: follow the checklist at the end in order. Fictional data only.
Ports: inventory-service 3004, booking-service 3005, payment-service 3006. New databases: `inventory`, `booking`, `payment`
(add to `infra/postgres/init.sql`; on an existing volume create them by hand, see D1).

## 0. Cross-cutting rules

- **Internal routes** live at root `/internal/...` (never under the `/inventory|/booking|/payment` prefix the gateway forwards to).
  They require header `x-internal-token` = `INTERNAL_TOKEN` (env, constant-time compare). The gateway must delete any client
  `x-internal-token` header and return 404 for any path whose decoded form contains `/internal` or `..`. Two layers, because the
  gateway forwards `req.url` verbatim.
- **Service-to-service HTTP:** one small helper per service: `fetch` + `AbortSignal.timeout(2000)`, 3 attempts, backoff 200/400/800 ms
  with jitter, retry only on network error, 502/503/504. Never retry 4xx. Forward `x-request-id`.
- **Never log:** holder keys, card numbers, CVC, VPAs, idempotency keys are fine to log. Fastify must not log request bodies.
- **Every state change is a guarded UPDATE:** `UPDATE ... SET state=$new, updated_at=now() WHERE id=$id AND state=$expected`.
  `rowCount = 0` means another actor (handler, callback, sweeper) already moved it: reload and stop. This is the optimistic lock
  that makes the handler, the payment callback and the sweeper safe to race.

## 1. Inventory data model and ownership

Catalog keeps display data and **prices** (`ticket_tiers.price_inr`). Inventory keeps only stock and seat state. Inventory never
stores prices, so there is one price source. Booking prices orders from catalog (section 5), never from the client.

```sql
CREATE TABLE event_inventory (event_id uuid PRIMARY KEY, seat_map jsonb);   -- seat_map: viewBox, stage rect, section labels (layout only)
CREATE TABLE tier_stock (                                                    -- one row per catalog tier
  tier_id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES event_inventory,
  kind text NOT NULL CHECK (kind IN ('ga','seated')),
  capacity int NOT NULL CHECK (capacity >= 0),
  sold int NOT NULL DEFAULT 0, CHECK (sold BETWEEN 0 AND capacity));        -- GA guard; for seated, sold is informational
CREATE TABLE seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL, tier_id uuid NOT NULL REFERENCES tier_stock,
  section text NOT NULL, row_label text NOT NULL, number int NOT NULL, x real NOT NULL, y real NOT NULL,
  UNIQUE (event_id, section, row_label, number));
CREATE TABLE seat_sales (seat_id uuid PRIMARY KEY REFERENCES seats, order_id uuid NOT NULL, sold_at timestamptz DEFAULT now());
CREATE TABLE ga_sales (order_id uuid, tier_id uuid REFERENCES tier_stock, qty int NOT NULL CHECK (qty > 0), PRIMARY KEY (order_id, tier_id));
```

- `seat_sales.seat_id PRIMARY KEY` makes selling a seat twice physically impossible. `ga_sales` PK makes GA confirm idempotent per order;
  `CHECK (sold <= capacity)` plus the guarded UPDATE makes GA overselling impossible.
- **Provisioning (how inventory learns about events):** catalog has no outbox and no write API yet (D19). For Phase 4, the inventory
  seed (`services/inventory-service/seed/seed.js`) reads `GET {GATEWAY}/api/catalog/events/:slug` (public) to get `eventId` and tier
  ids by name, then upserts `event_inventory`, `tier_stock`, `seats` from its own layout file. Seated: the orchestra event (Balcony /
  Stalls / Front Stalls, ~200 seats) and one comedy event. All other tiers are GA with fictional capacities. Root `pnpm seed` runs
  catalog seed then inventory seed. Idempotent: upsert on `tier_id` and on `(event_id, section, row_label, number)`.
- **Revisit (Phase 8):** organiser edits in catalog should emit `event.published`/`tier.updated` via outbox, consumed by inventory.

## 2. Holds: Redis TTL, Postgres is the only guarantee

Holds live in Redis (CLAUDE.md). **Correctness never depends on Redis:** the sale is a Postgres insert/guarded update. Redis loss
can only cause a buyer to pay and then be refunded; it can never cause a double sale. Redis default `noeviction` must stay.

Hold owner = `orderId` (booking creates the order first). Users never call inventory mutations; only booking does, via `/internal`.
Booking always sends the items again on release/confirm, so inventory keeps no hold metadata. TTL `HOLD_TTL_SECONDS=480`.

Keys (hash tag `{eventId}` for future cluster use): seat `inv:{E}:seat:<seatId>` -> orderId. GA per tier: `inv:{E}:ga:<T>:held`
(int), `inv:{E}:ga:<T>:exp` (zset orderId -> expiry ms), `inv:{E}:ga:<T>:qty` (hash orderId -> qty).

**Seat hold, all-or-nothing** (`ARGV[1]`=orderId, `ARGV[2]`=ttlMs; re-running for the same order refreshes, so it is idempotent):
```lua
for i, k in ipairs(KEYS) do local v = redis.call('GET', k)
  if v and v ~= ARGV[1] then return i end end           -- conflict: 1-based index of first taken seat
for _, k in ipairs(KEYS) do redis.call('SET', k, ARGV[1], 'PX', ARGV[2]) end
return 0
```
Then inventory checks Postgres: `SELECT seat_id FROM seat_sales WHERE seat_id = ANY($1)`. If any are sold, run release and return
409 `seats_unavailable`. Acquire-then-check (not check-then-acquire) closes the window where a seat is sold between the two steps,
because confirm deletes Redis keys only after its commit.

**Seat release:** for each key, `if GET == orderId then DEL`. **Extend:** same as hold script with a new TTL (fails if not owner).

**GA hold** (`KEYS`=held, exp, qty; `ARGV`=orderId, qty, capacity, soldFromPg, nowMs, expiryMs):
```lua
local gone = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
for _, id in ipairs(gone) do local q = redis.call('HGET', KEYS[3], id)
  if q then redis.call('DECRBY', KEYS[1], q) end
  redis.call('ZREM', KEYS[2], id); redis.call('HDEL', KEYS[3], id) end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1]); return 0 end
local held = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[4]) + held + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return -1 end   -- sold out
redis.call('INCRBY', KEYS[1], ARGV[2]); redis.call('HSET', KEYS[3], ARGV[1], ARGV[2]); redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1])
return 0
```
`soldFromPg` is read from `tier_stock.sold` just before the script. It can be momentarily stale (one hold over-admitted); the PG
guard at confirm catches it. GA release: if `HGET qty orderId` exists then DECRBY, ZREM, HDEL (one Lua script).

**Confirm (hold -> sold),** `POST /internal/holds/:orderId/confirm`:
1. Seats: fence with Lua: every key must be absent or equal orderId, else 409 (a live hold by someone else wins); then `SET key orderId PX 60000`.
2. One PG transaction: seats `INSERT INTO seat_sales (seat_id, order_id) SELECT unnest($ids::uuid[]), $o ON CONFLICT (seat_id) DO NOTHING`,
   then `SELECT count(*) FROM seat_sales WHERE seat_id = ANY($ids) AND order_id = $o` must equal n, else ROLLBACK -> 409.
   GA: `INSERT INTO ga_sales ... ON CONFLICT DO NOTHING RETURNING 1`; only if a row was inserted,
   `UPDATE tier_stock SET sold = sold + $q WHERE tier_id = $t AND sold + $q <= capacity` must hit 1 row, else ROLLBACK -> 409 `sold_out`.
3. After COMMIT: release the Redis keys (compare-and-delete). Re-calling confirm for an already-sold order returns 200 (idempotent).

Why not `SELECT ... FOR UPDATE SKIP LOCKED`: that suits "give me any free seat"; we sell specific seats, and a PK constraint is a
stronger, simpler guarantee. SKIP LOCKED is used in the booking sweeper instead.

**Redis restart:** all holds vanish. Buyers mid-checkout may lose seats to others; confirm then 409s and booking refunds. No oversell.

**Concurrency test** (`services/inventory-service/test/race.test.js`, real PG + Redis): (a) 50 parallel holds on one seat with
different orderIds -> exactly 1 returns 0; (b) 50 parallel confirms on one seat with different orderIds, Redis flushed first
(simulates Redis loss) -> exactly 1 success, `seat_sales` has 1 row; (c) GA capacity 10, 50 parallel qty-1 holds -> exactly 10,
then 50 parallel confirms bypassing holds -> `sold = 10`. Redis must be published on `127.0.0.1:6379` (dev only, like Postgres, D14).

## 3. Booking saga (orchestration in booking-service)

```
PENDING --hold ok--> HELD --pay--> PAYMENT_PENDING --succeeded--> PAID --confirm ok--> CONFIRMED (outbox order.confirmed)
PENDING --hold 409/err--> FAILED          HELD --user cancel--> CANCELLED       HELD --expiry--> EXPIRED
PAYMENT_PENDING --failed--> HELD (attempt < 3 and hold valid) | FAILED (else, release hold)
PAID --confirm 409--> REFUND_PENDING --refund ok--> REFUNDED (outbox order.refunded)
```
Terminal: CONFIRMED, FAILED, CANCELLED, EXPIRED, REFUNDED. Every transition into FAILED/CANCELLED/EXPIRED/REFUNDED releases the cap
in the **same transaction** (section 5) and calls inventory release (idempotent, after commit; sweeper retries on failure).

Tables: `orders (id, user_id, event_id, holder_key, state, idempotency_key, request_hash, total_inr, hold_expires_at,
payment_deadline, current_payment_id, attempts int, failure_reason, next_check_at, created_at, updated_at, UNIQUE(user_id, idempotency_key))`,
`order_items (order_id, tier_id, seat_id null, seat_label null, qty, unit_price_inr)`, `payment_attempts (order_id, attempt_no,
idempotency_key, request_hash, payment_id, status, PK(order_id, attempt_no), UNIQUE(order_id, idempotency_key))`, `cap_usage`, `outbox`.

Steps (sync HTTP for the saga's request/response steps; events only for downstream fan-out):
1. `POST /booking/orders`: eligibility + price + cap reserve + INSERT order (PENDING) in one tx. Then inventory hold. On 200:
   PENDING -> HELD with `hold_expires_at`. On 409: -> FAILED (`seats_unavailable`/`sold_out`), return 409. On network error: leave
   PENDING, return 503; sweeper resolves.
2. `POST /booking/orders/:id/pay`: guarded `HELD -> PAYMENT_PENDING, attempts+1` requiring `hold_expires_at > now() + 30s`, else
   409 `hold_expired`. Extend the hold to `now() + 180s` (covers payment deadline 60s + confirm margin). Call payment-service with key
   `pay:{orderId}:{attemptNo}`. Return 202 with order; client polls.
3. Callback/status `succeeded` -> PAID -> inventory confirm -> in one tx: CONFIRMED + `writeOutbox('order.confirmed')`.
4. Confirm 409 -> REFUND_PENDING -> payment refund (key `refund:{paymentId}`) -> REFUNDED + cap release + `order.refunded`.

Compensation per failure point: payment declined -> HELD (retry) or FAILED + release; payment timeout/unknown -> sweeper asks
payment-service, then `cancel` (definitive outcome, see 6); hold expired mid-payment -> confirm re-acquires if seats are free, else
409 -> refund; confirm fails after payment -> refund; booking crash anywhere -> sweeper. After CONFIRMED nothing is compensated in
Phase 4: ticket issuing (Phase 5) consumes `order.confirmed` and retries on its own.

**Sweeper** (every 5 s, safe with multiple instances). Claim a lease, commit, then do HTTP outside the lock:
```sql
UPDATE orders SET next_check_at = now() + interval '30 seconds'
WHERE id IN (SELECT id FROM orders WHERE state IN ('PENDING','HELD','PAYMENT_PENDING','PAID','REFUND_PENDING')
             AND next_check_at <= now() ORDER BY next_check_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *;
```
- PENDING older than 30 s -> release hold, FAILED. HELD past `hold_expires_at` -> EXPIRED.
- PAYMENT_PENDING past `payment_deadline` -> `GET /internal/payments/:id`; if still processing -> `POST /internal/payments/:id/cancel`;
  apply the returned final status. If the create call itself never answered, re-POST with the same idempotency key first.
- PAID -> retry confirm. REFUND_PENDING -> retry refund. Backoff by pushing `next_check_at` (5 s, 15 s, 60 s, cap 5 min).

## 4. Idempotency

- Header `Idempotency-Key` (8-128 chars, client sends a UUID) is **required** on `POST /booking/orders`, `POST /booking/orders/:id/pay`,
  `POST /booking/orders/:id/cancel`. Missing -> 400 `idempotency_key_required`. Scope: per user (`UNIQUE(user_id, key)`).
- Natural-key storage, no generic key table: `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`. On conflict,
  load the existing row: different `request_hash` (sha256 of route + canonical sorted-key JSON of the validated body) -> 422
  `idempotency_key_reused`; same -> 200 with the **current** order state (not a byte-identical replay; documented trade-off).
  Concurrent duplicates serialize on the unique index; the loser returns the current state (maybe PENDING; client polls).
- Pay uses `payment_attempts UNIQUE(order_id, idempotency_key)` the same way. Cancel is naturally idempotent (guarded transition).
- Booking -> payment keys are **derived**, never random: `pay:{orderId}:{attemptNo}`, `refund:{paymentId}`. Retries after a timeout
  reuse the key, so payment-service returns the existing payment instead of charging twice.
- Callback idempotency: booking applies callbacks through guarded transitions keyed on `current_payment_id`; duplicates are 200 no-ops.

## 5. Anti-scalper enforcement

- **Eligibility** at `POST /booking/orders` (sync, in parallel, 2 s timeout): auth-service `GET /internal/users/:id` ->
  `{ emailVerified, name }`; aadhaar-service `GET /internal/holders/:userId` -> `{ verified, holderKey }`. Not email-verified -> 403
  `email_not_verified`; not Aadhaar-verified -> 403 `aadhaar_not_verified`. Either service down -> 503 (fail closed).
- **holderKey, not the raw hash:** aadhaar-service returns `holderKey = HMAC-SHA256(AADHAAR_HASH_SECRET, "holder:v1:" + aadhaar_hash)`.
  The uniqueness hash never leaves aadhaar-service; a leaked booking DB cannot be joined to the aadhaar DB. Stable per Aadhaar, so
  the cap is per Aadhaar even if accounts are ever unlinked/relinked. Never logged, never in events or API responses.
- **Cap and price source:** catalog adds `GET /internal/events/:id` -> `{ id, status, startsAt, ticketCap, hotSale, tiers:[{id, priceInr}] }`.
  Not `published` or already started -> 422 `event_not_on_sale`. Unknown tier -> 400.
- **Race-safe cap reservation**, same tx as the order INSERT:
```sql
-- cap_usage (event_id uuid, holder_key text, qty int NOT NULL CHECK (qty >= 0), PRIMARY KEY (event_id, holder_key))
INSERT INTO cap_usage (event_id, holder_key, qty) SELECT $1, $2, $3 WHERE $3 <= $4
ON CONFLICT (event_id, holder_key) DO UPDATE SET qty = cap_usage.qty + EXCLUDED.qty
  WHERE cap_usage.qty + EXCLUDED.qty <= $4
RETURNING qty;   -- 0 rows => 409 ticket_cap_exceeded { cap, remaining }
```
  The row lock serializes concurrent orders by the same holder. Counts confirmed + in-flight. Released
  (`UPDATE cap_usage SET qty = qty - $n`) in the same tx as entering FAILED/CANCELLED/EXPIRED/REFUNDED.
- **Test** (`services/booking-service/test/cap.test.js`): cap 4, 10 parallel qty-1 orders with the same holderKey -> exactly 4 HELD;
  one goes FAILED -> a fifth succeeds. Two users share no cap.

## 6. payment-service (mock)

Table `payments (id, idempotency_key UNIQUE, request_hash, order_id, amount_inr, method ('card'|'upi'), instrument_hint, status,
created_at, updated_at)`; `refunds (id, payment_id UNIQUE, idempotency_key UNIQUE, status, created_at)`.
States: `processing -> succeeded | failed | cancelled`; `succeeded -> refunded`. Guarded transitions as in section 0.

Request: `{ orderId, amountInr, method, card?: { number, expMonth, expYear, cvc }, upi?: { vpa } }`. Only the outcome, method and
`instrument_hint` (card last 4, or `upi`) are stored. Number, CVC and VPA are never stored or logged. Deterministic fictional triggers:

| Input | Outcome |
|---|---|
| card `4242 4242 4242 4242`, UPI `success@authentix` | succeeded after ~1 s |
| card `4000 0000 0000 0002`, UPI `fail@authentix` | failed (`declined`) after ~1 s |
| card `4000 0000 0000 9999`, UPI `timeout@authentix` | stays `processing`, no callback; auto-fails after 5 min unless cancelled |
| card `4000 0000 0000 0077` | succeeded after 20 s (for hold-expiry demos with a short `HOLD_TTL_SECONDS`) |
| anything else | 400 `unsupported_test_instrument` |

Delayed outcomes are persisted (`resolve_at` column) and applied by a 1 s poller, so a restart does not lose them.
Callback: `POST {BOOKING}/internal/payments/callback` body `{ paymentId, orderId, status, occurredAt }`, headers `x-timestamp` and
`x-signature = hex(HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, timestamp + "." + rawBody))`. Booking rejects skew > 5 min and bad
signatures (timingSafeEqual). Payment-service retries the callback 5 times with backoff; the booking sweeper is the backstop.
`cancel` on a `processing` payment -> `cancelled`; on a final payment it returns the final status unchanged.

## 7. API surface

Public (via gateway; add `inventory` and `booking` routes; **do not route `payment`**; add `GET /api/inventory/` to public reads):

| Route | Notes |
|---|---|
| `GET /inventory/events/:eventId` | public. `{ eventId, seatMap: { viewBox, stage, sections } \| null, tiers: [{ tierId, kind, available }], seats: [{ id, tierId, section, row, number, x, y, status: 'available'\|'held'\|'sold' }] }` (`held` via MGET) |
| `POST /booking/orders` | `{ eventId, items: [{ tierId, quantity }] \| [{ tierId, seatId }] }`, max 10 units. 201/200 order; 400, 403, 409 `seats_unavailable {seatIds}` / `sold_out` / `ticket_cap_exceeded`, 422, 503 |
| `GET /booking/orders/:id` | owner only (404 otherwise). Order shape below |
| `GET /booking/orders?active=true` | the user's latest non-terminal order, for resume |
| `POST /booking/orders/:id/pay` | `{ method, card? \| upi? }` -> 202; 409 `hold_expired` / `invalid_state` / `payment_attempts_exhausted` |
| `POST /booking/orders/:id/cancel` | HELD only -> CANCELLED |

Order shape: `{ id, state, eventId, items: [{ tierId, seatId, seatLabel, quantity, unitPriceInr }], totalInr, holdExpiresAt,
serverTime, attempts, failureReason, createdAt }` (`serverTime` lets the client correct clock skew in the countdown).

Internal (`x-internal-token`): inventory `POST /internal/holds` `{ orderId, eventId, items, ttlSeconds }`, `POST /internal/holds/:orderId/extend`,
`/release`, `/confirm` (all with items); payment `POST /internal/payments`, `GET /internal/payments/:id`, `POST /internal/payments/:id/cancel`,
`POST /internal/payments/:id/refund`; booking `POST /internal/payments/callback` (HMAC, no token needed); auth `GET /internal/users/:id`;
aadhaar `GET /internal/holders/:userId`; catalog `GET /internal/events/:id`.

Contracts to add: `contracts/order.confirmed.schema.json` `{ orderId, userId, eventId, items: [{ tierId, seatId|null, seatLabel|null,
quantity, unitPriceInr }], totalInr, confirmedAt }` and `contracts/order.refunded.schema.json` `{ orderId, userId, eventId,
reason: 'seats_unavailable'|'sold_out', refundedAt }`. No holderKey, no payment instrument data. Mirror in `@authentix/schemas`.

## 8. Web checkout requirements

Event detail -> seat map (SVG from `seats` x/y, colour by status, prices joined from catalog tiers) or GA quantity picker capped
at the remaining cap -> `POST /booking/orders` (generate the Idempotency-Key once per click and reuse it on retry) -> checkout page
with countdown from `holdExpiresAt - serverTime` -> pay form (show the test instruments) -> poll `GET /booking/orders/:id` every 2 s
while PAYMENT_PENDING/PAID -> confirmation, or a clear failure/refund message. On load, call `?active=true` to resume.
Show 403 reasons with a link to verification. Refresh seat map on 409 `seats_unavailable`.

## Open questions (please decide)

1. Live hold beats paid-but-expired order at confirm (the payer gets refunded). Alternative: the payer wins and the holder fails. I chose to respect holds.
2. Hot-sale events: should `POST /booking/orders` reject hot-sale events until Phase 6 adds the admission token, or allow them now?
3. Transfers (Phase 5) move tickets between holders: should the recipient's cap count them? Affects `cap_usage`.
4. Price is read live from catalog at order time; a Phase 8 price edit mid-checkout would not change existing orders. OK?
5. Payment retries: 3 attempts per order while the hold is valid. Fine, or one attempt only (simpler)?

## Implementation checklist (each step independently checkable)

1. Add `inventory`, `booking`, `payment` to `init.sql`; create them by hand on the dev volume. Publish Redis on `127.0.0.1:6379`. Add `INTERNAL_TOKEN`, `PAYMENT_WEBHOOK_SECRET`, `HOLD_TTL_SECONDS` to `.env.example`. Check: `psql -l`, `redis-cli ping`.
2. Gateway: strip `x-internal-token`, 404 on `/internal` or `..` in the decoded path, add `inventory`/`booking` routes, public `GET /api/inventory/`. Check: curl `/api/booking/../internal/x` -> 404.
3. Shared internal-HTTP helper (timeout, retries, backoff, request ID) and an `x-internal-token` preHandler. Put them in a small shared package or copy them per service.
4. Internal reads: catalog `GET /internal/events/:id`, auth `GET /internal/users/:id`, aadhaar `GET /internal/holders/:userId` (holderKey). Check: curl with and without the token.
5. inventory-service skeleton: schema, healthz/readyz, `GET /inventory/events/:eventId`.
6. Inventory seed + layout file; root `pnpm seed` runs both seeds. Check: the seat map JSON for the orchestra event.
7. Inventory holds: the Lua scripts in section 2, `/internal/holds` hold/extend/release/confirm. Check: manual curl flow.
8. `race.test.js` (section 2 a-c). Must pass before continuing.
9. payment-service: schema, create/get/cancel/refund, the trigger table, `resolve_at` poller, signed callback with retries.
10. booking-service skeleton: schema, outbox relay, order shape, `GET` routes.
11. `POST /booking/orders`: eligibility, catalog price/cap, cap upsert, idempotency, inventory hold.
12. `cap.test.js` (section 5).
13. Pay, callback, confirm, refund paths, and cancel. Contracts and Zod schemas for `order.confirmed` / `order.refunded`.
14. Sweeper with lease claim.
15. `saga.test.js` with fake inventory/payment clients injected and real PG: decline -> HELD then FAILED after 3 attempts with cap released; hold expires before pay -> EXPIRED; pay succeeds but confirm 409 -> REFUNDED with cap released; crash in PAID -> sweeper confirms.
16. Compose entries (no published ports), `scripts/check.sh` covers the new services.
17. Web: seat map / GA picker, checkout with countdown, pay form, polling, resume, error states.
18. Append D26+ to `docs/decisions.md` summarising this note; run `docs/demo.md` steps by hand.
