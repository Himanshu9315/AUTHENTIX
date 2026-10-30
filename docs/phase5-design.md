# Phase 5 design: tickets, rotating QR, transfers, gate entry, scanner, My Tickets

Status: proposed (architect). Implementer: follow the checklist at the end in order. Fictional data only.
Ports: ticket-service 3007, gate-service 3008, scanner app 8081. New databases: `ticket`, `gate` (add to `infra/postgres/init.sql`;
create by hand on the existing dev volume, see D1). Phase 4 cross-cutting rules (section 0 of `phase4-design.md`) still apply:
`/internal` routes + `x-internal-token`, `internalFetch` with timeout/retry, guarded UPDATEs, no request-body logging.

## 0. Ownership in one paragraph

**ticket-service owns tickets and every security decision about them**: issuance, the QR secret, token verification, the one-time
"used" flag, transfers. **gate-service owns the staff-facing scan API**: staff scoping, scan idempotency, the audit log, live counts.
Gate never holds a QR key; it forwards the raw token to ticket-service. Reason: "used", "version" and "owner" must change in one
row under one lock, or a transfer can race an entry. Cost: one internal hop per scan (docker network, a few ms). booking-service
stays the only owner of `cap_usage`; transfers move cap through new internal endpoints there.

## 1. Rotating QR (D39)

**Key material.** One env secret `QR_MASTER_KEY` (32 random bytes, base64), in ticket-service only. The per-ticket secret is
*derived*, never stored:
```js
ticketSecret = hmac(QR_MASTER_KEY, `authentix:qr:v1:${ticketId}:${version}`)   // 32 bytes
```
- Nothing secret at rest: a leaked `ticket` DB cannot mint QR codes. No encryption-at-rest scheme to get wrong.
- Binding to `version` means a transfer (version + 1) changes the secret, so every old token dies the moment the transfer commits.
- Why per-ticket at all (vs one MAC over the master key): matches CLAUDE.md, and lets a future native app receive one ticket's
  secret for offline generation without exposing any other ticket.
- Risk: master key leak = every ticket forgeable. Mitigation: only ticket-service has it; the format byte reserves room for a key id.
  **Revisit:** key rotation (`QR_MASTER_KEY_PREVIOUS`, format byte 0x02).

**Token format** (41 bytes, base64url, 55 chars; fits QR version 4 at ECC level M in byte mode):
```
0x01 | ticketId (16 bytes, uuid) | version (u32 BE) | step (u32 BE) | mac (first 16 bytes of HMAC-SHA256(ticketSecret, bytes[0..25)))
step = floor(unixMs / 30000)
```
Event id is not in the token: the ticket id determines the event, and gate checks it against the event being scanned.

**Verification** (ticket-service, pure function, then DB):
1. base64url-decode; length must be 41 and byte 0 must be 0x01, else `invalid_qr`.
2. Recompute the MAC from the derived secret; `crypto.timingSafeEqual`, else `invalid_qr`. Signature is checked *before* any DB read,
   so forged tokens learn nothing about which ticket ids exist.
3. `|step - stepAt(at)| <= 1`, else `qr_expired`. `at` is the scan time (below). Plus/minus one step = worst case 90 s validity:
   one step back covers a code shown just before a boundary plus network/scan delay; one forward covers a phone clock slightly
   ahead. The phone already corrects its clock from `serverTime`, so wider windows buy nothing and widen the screenshot window.
4. DB guarded UPDATE (section 2) checks version, status, event.

**How the phone gets tokens.** `GET /tickets/:id/qr` (owner only, `Cache-Control: no-store`) returns a batch of the next 10 steps
(5 minutes): `{ ticketId, version, stepSeconds: 30, serverTime, tokens: [{ step, token, validFrom, validTo }] }`. The client shows
the token for the current corrected step and refetches when 2 or fewer steps remain. Trade-off: no secret reaches the browser (the
secret would be extractable from web storage), and a venue with bad signal still gets 5 minutes of codes. A strict "fetch every 30 s"
is safer but fails at crowded gates. See open question 1.

**Screenshot/replay resistance.** A screenshot is valid for at most ~90 s, entry is one-time per ticket, and the gate shows the holder
name. A screenshot forwarded within 90 s can still get *one* person in; that is the residual risk, accepted for v1.

## 2. Entry marking (D40)

**Scan time.** The scanner sends `scannedAt` (device time corrected by its last `serverTime`). ticket-service computes
`at = min(scannedAt, now)`; if `scannedAt < now - SCAN_GRACE_SECONDS` (default 120) -> `scan_stale` ("rescan"). This lets a scan
queued during a short network drop be judged at its capture time, while a screenshot still fails because its token was already old
when captured. Only staff can submit scans, and the grace is short.

**One atomic UPDATE in ticket-service** (`POST /internal/admissions`):
```sql
UPDATE tickets SET status = 'used', used_at = now(), used_gate = $gate, used_scan_id = $scanId, used_by = $staffId, updated_at = now()
WHERE id = $ticketId AND version = $version AND event_id = $eventId AND status = 'active'
RETURNING id, holder_display, seat_label, tier_id, used_at, used_gate;
```
0 rows -> `SELECT` the ticket and classify, in this order: missing -> `invalid_qr`; other event -> `wrong_event`; `status='used' AND
used_scan_id = $scanId` -> **admitted** (idempotent replay of the same scan); used -> `already_used { usedAt, usedGate }`;
`status='void'` -> `ticket_void`; version differs -> `ticket_replaced` ("this QR was replaced, e.g. transferred"). Concurrent scans
of one QR at many gates serialize on the row lock: exactly one row update, everyone else sees `already_used`.

**gate-service `POST /gate/scans`** (staff only), body `{ scanId: uuid, eventId, gateId: string(1..32), token: string(<=100), scannedAt }`:
1. `SELECT` scan by `scanId`: exists with same `(staff, eventId)` -> return stored result; different -> 422 `scan_id_reused`.
2. Event open check (catalog `GET /internal/events/:id`, cached 60 s): `startsAt - 6h <= now <= startsAt + 12h`, else rejected
   `event_not_open` (stored like any other outcome).
3. Call ticket-service admissions. Network error/5xx -> 503, **nothing stored**, scanner retries the same `scanId`.
4. `INSERT INTO scans ... ON CONFLICT (scan_id) DO NOTHING`, then return the stored row (first writer wins).
Rejections are HTTP 200 with `result: 'rejected'` (a business outcome the scanner displays); 4xx only for malformed or forbidden.
The token is never stored or logged; the scan row keeps `ticket_id` only.

Re-entry: none in v1. Staff scoping v1: any `staff` user may scan any event inside the open window (open question 3).
Live count: `GET /gate/events/:eventId/stats` -> `{ admitted, rejected, issued, used, lastScanAt, serverTime }` (`admitted/rejected`
from `scans`; `issued/used` from ticket-service `GET /internal/events/:id/ticket-counts`; `used` is authoritative).

`scans (scan_id uuid PK, staff_user_id uuid, event_id uuid, gate_id text, ticket_id uuid null, result text CHECK IN
('admitted','rejected'), reason text null, holder_display text null, seat_label text null, used_at timestamptz null,
used_gate text null, scanned_at timestamptz, created_at timestamptz DEFAULT now())`, index `(event_id, created_at)`.

## 3. ticket-service data model and issuance (D41)

```sql
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issue_key text NOT NULL UNIQUE,   -- dedupe for redelivered order.confirmed
  order_id uuid NOT NULL, event_id uuid NOT NULL, tier_id uuid NOT NULL, seat_id uuid, seat_label text,
  owner_user_id uuid NOT NULL, holder_display text NOT NULL,        -- snapshot "Asha K.", refreshed on transfer
  version int NOT NULL DEFAULT 1, transfer_count int NOT NULL DEFAULT 0 CHECK (transfer_count BETWEEN 0 AND 2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','void')),
  used_at timestamptz, used_gate text, used_scan_id uuid, used_by uuid,
  issued_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX tickets_one_per_seat ON tickets (event_id, seat_id) WHERE seat_id IS NOT NULL AND status <> 'void';
CREATE INDEX tickets_owner ON tickets (owner_user_id, event_id);
CREATE TABLE ticket_owners (ticket_id uuid REFERENCES tickets, version int, owner_user_id uuid NOT NULL, from_user_id uuid,
  reason text NOT NULL CHECK (reason IN ('issued','transfer')), created_at timestamptz DEFAULT now(), PRIMARY KEY (ticket_id, version));
-- transfers: section 4. outbox: OUTBOX_DDL.
```
- **issue_key** = `${orderId}:${seatId}` for seats, `${orderId}:${tierId}:ga:${n}` for GA where `n` is 1..total GA units of that tier
  in the order (sum across items, so duplicate items for one tier are still deterministic).
- **Handler for `order.confirmed`:** validate with `orderConfirmedSchema` (fail -> permanent). Fetch `name` from auth
  `GET /internal/users/:userId` (fail -> transient retry). One tx: `INSERT ... ON CONFLICT (issue_key) DO NOTHING RETURNING id` for
  every unit, a `ticket_owners` row (version 1, `issued`) per inserted ticket, and if any were inserted, `writeOutbox('ticket.issued')`.
  Redelivery inserts nothing and emits nothing. A `tickets_one_per_seat` violation means an inventory bug: permanent, parked, logged
  at error level.
- **holder_display:** first whitespace token of `name` + space + first letter of last token + "."; single-token names show the token.
  Snapshot (not live lookup) so the gate never calls auth and data held is minimal. Full names are not stored.
- **order.refunded is not consumed.** The saga never refunds a CONFIRMED order (CONFIRMED is terminal; refunds happen only from PAID
  or for late payments of failed orders). `void` exists for organiser cancellation (Phase 8), which must void tickets and refund.

**Consumer helper in `packages/events`** (D42), same reconnect style as the relay:
```js
startConsumer({ url, logger, queue: "ticket-service", bindings: ["order.confirmed"], prefetch: 10,
  maxAttempts: 8, retryDelayMs: 10_000, handler: async (event /* {id,type,occurredAt,requestId,payload} */) => {} })
// -> { stop(): Promise<void>, isHealthy(): boolean };  export class PermanentError extends Error {}
```
Topology (all durable, asserted on connect): `queue` bound to `authentix.events` for each binding, with `x-dead-letter-exchange: ""`
and `x-dead-letter-routing-key: queue.retry`; `queue.retry` with `x-message-ttl: retryDelayMs` dead-lettering back to `queue`;
`queue.parked` (no consumer). Handler ok -> `ack`. Throws `PermanentError`, or attempts (from the `x-death` count) reached
`maxAttempts` -> publish to `queue.parked`, then `ack`. Any other error -> `nack(msg, false, false)` (goes to retry). Malformed
JSON -> parked. Dispatch on `event.type`, never the routing key (it changes after a retry hop). Handlers must be idempotent by a
natural key; the helper does no messageId dedupe. Wire `isHealthy` into `/readyz`.

## 4. Transfers (D43)

Rules (user-approved): max 2 transfers per ticket (`transfer_count`), none within 24 h of `startsAt`, recipient must be email-verified
and Aadhaar-verified, identified by email, not the sender. No price field anywhere. Recipient's cap counts the ticket, the sender's
share is released.

**Cap moves are reserve-before, release-after.** At every intermediate point (including crashes) cap usage is over-counted, never
under-counted, so nobody can ever exceed the cap. New booking-service table and internal routes:
```sql
CREATE TABLE cap_transfers (id uuid PRIMARY KEY /* = transferId */, event_id uuid NOT NULL, from_key text NOT NULL, to_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','committed','reverted')), created_at timestamptz DEFAULT now(), updated_at timestamptz);
```
- `POST /internal/cap-transfers` `{ transferId, eventId, fromHolderKey, toHolderKey }`: one tx: `INSERT ... 'reserved' ON CONFLICT DO
  NOTHING RETURNING id`; if inserted, run the D31 cap upsert for `to_key` with qty 1 and the catalog `ticketCap` (booking reads it
  itself; catalog down -> 503); 0 rows -> ROLLBACK, 409 `ticket_cap_exceeded`. Not inserted -> 200 with the existing state.
- `POST /internal/cap-transfers/:id/commit`: `UPDATE ... SET state='committed' WHERE id=$1 AND state='reserved' RETURNING *`; if a row
  came back, `UPDATE cap_usage SET qty = GREATEST(0, qty - 1)` for `from_key`, same tx. Repeat -> 200 no-op. `reverted` -> 409.
- `POST /internal/cap-transfers/:id/revert` (same body as reserve): unknown id -> insert a `reverted` **tombstone** so a late
  reserve can never apply; `reserved` -> `reverted` and decrement `to_key`; `committed` -> 409 (ticket-service never asks this).

**ticket-service table:**
`transfers (id uuid PK, ticket_id uuid, from_user uuid, to_user uuid, from_version int, state text CHECK IN ('pending','done','failed'),
failure_reason text, cap_settled bool DEFAULT false, idempotency_key text, request_hash text, next_check_at timestamptz,
created_at, updated_at, UNIQUE (from_user, idempotency_key))` + `CREATE UNIQUE INDEX one_pending_transfer ON transfers (ticket_id)
WHERE state = 'pending'`.

**`POST /tickets/:id/transfer`** `{ recipientEmail }`, header `Idempotency-Key` required (same rules as D30, request_hash over the
normalised email). Flow:
1. Load ticket: not owner -> 404; `status='used'` -> 409 `ticket_used`; void -> 409 `ticket_void`; `transfer_count >= 2` -> 422
   `transfer_limit_reached`. Catalog `startsAt - now < 24h` -> 422 `transfer_window_closed` (catalog down -> 503, fail closed).
2. In parallel: auth `POST /internal/users/lookup {email}` -> `{ id, name, emailVerified }` | 404; then aadhaar `GET /internal/holders/:id`
   for recipient and sender. Recipient id = sender -> 422 `cannot_transfer_to_self`. Missing, unverified email or Aadhaar -> 422
   `recipient_not_eligible`. Any dependency down -> 503.
3. Tx1: `INSERT transfers (pending, from_version = ticket.version, next_check_at = now() + 60s)`. Unique pending index violation ->
   409 `transfer_in_progress`. Idempotent replay -> return the existing transfer's current state.
4. booking reserve. 409 -> transfer `failed` (`recipient_cap_exceeded`), `cap_settled = true`, reply 422 `recipient_not_eligible`.
   Network error -> leave pending, 503 (sweeper resolves).
5. Tx2 (the re-issue, atomic):
```sql
UPDATE transfers SET state='done', updated_at=now() WHERE id=$t AND state='pending';               -- 0 rows: sweeper won, ROLLBACK
UPDATE tickets SET owner_user_id=$to, holder_display=$disp, version=version+1, transfer_count=transfer_count+1, updated_at=now()
 WHERE id=$ticket AND owner_user_id=$from AND version=$fromVersion AND status='active' AND transfer_count < 2 RETURNING version;
-- 0 rows: ROLLBACK, then mark transfer failed (guarded) and revert cap; reply 409 ticket_changed (or ticket_used after a reload)
INSERT INTO ticket_owners (ticket_id, version, owner_user_id, from_user_id, reason) VALUES ($ticket, $newVersion, $to, $from, 'transfer');
-- writeOutbox('ticket.transferred', ...)
```
   Version bump = new derived secret: the old QR is dead at COMMIT. No separate secret write.
6. After commit: booking commit; success -> `cap_settled = true`. Failure -> sweeper retries.

**Sweeper** (5 s, lease claim exactly like booking's): `pending` older than `next_check_at` -> guarded `pending -> failed`, then revert;
`done AND NOT cap_settled` -> commit; `failed AND NOT cap_settled` -> revert. Backoff by pushing `next_check_at`.

**Races.** Double transfer: unique pending index + version guard. Transfer vs entry scan: both guarded UPDATEs on the same row with
`status='active' AND version=$v`; whoever commits first wins. Entry wins -> transfer fails, cap reverted. Transfer wins -> scan gets
`ticket_replaced`.

**Enumeration.** Every "who is this email" outcome (unknown, unverified, cap full) is the same 422 `recipient_not_eligible` with one
neutral message; the response never contains the recipient's name or id. Only `cannot_transfer_to_self` differs (reveals nothing).
Gateway rate limit for `POST /api/tickets/*/transfer`: 10/hour per user (Redis bucket like the auth one). Emails go in bodies, never
URLs, and are never logged (log `transferId`).

**Events** (`contracts/`, mirrored in `@authentix/schemas`; ids only, no names, emails or holder keys):
- `ticket.issued` `{ orderId, userId, eventId, ticketIds: uuid[] (min 1), issuedAt }` (one per order).
- `ticket.transferred` `{ transferId, ticketId, eventId, fromUserId, toUserId, newVersion, transferredAt }`.
Phase 7 notification-service consumes both (email both parties; it looks up contact details itself). No entry events in v1.

## 5. Authorization (D44)

- **Gateway role table**, checked after JWT verification, before proxying:
  `const ROLE_RULES = [{ prefix: "/api/gate/", roles: ["staff"] }];` first matching prefix wins; no match = any signed-in role.
  Mismatch -> 403 `{ error: "forbidden" }`. Match on the decoded, lower-cased path already computed for the `/internal` check.
- **Services re-check** (defence in depth): gate-service rejects `x-user-role !== 'staff'` with 403; ticket-service public routes
  require `x-user-id` and filter by `owner_user_id` (others' tickets are 404, never 403).
- Role staleness: role is in the 15-minute access JWT; refresh re-reads it. Accepted.
- **Staff seed:** `services/auth-service/seed/seed-staff.js`, run by root `pnpm seed`. Writes to auth's own DB (`DATABASE_URL`), upserts
  `gate.staff@example.test`, name "Demo Gatekeeper", role `staff`, `email_verified = true`, argon2 hash of `DEMO_STAFF_PASSWORD`
  (from `.env`, required, no default in code; `.env.example` gets a placeholder). Refuses to run when `NODE_ENV=production`. No admin API.

## 6. API surface

Gateway: add routes `tickets` -> ticket-service, `gate` -> gate-service; both authenticated (not public reads).

| Route | Notes |
|---|---|
| `GET /tickets` | caller's tickets: `[{ id, eventId, tierId, seatLabel, status, holderName, transfersLeft, transferable, issuedAt, usedAt }]`. Event display data comes from public catalog |
| `GET /tickets/:id` | same shape, owner only (404 otherwise) |
| `GET /tickets/:id/qr` | owner and `active` only; batch shape in section 1; 409 `ticket_used`/`ticket_void`; 404 if transferred away |
| `POST /tickets/:id/transfer` | section 4. 200 `{ transferId, state: 'done', ticketId }`; 400, 404, 409, 422, 503 as listed |
| `POST /gate/scans` | section 2. 200 `{ scanId, result, reason, holderName, seatLabel, tierId, usedAt, usedGate, serverTime }`; 400, 403, 422 `scan_id_reused`, 503 |
| `GET /gate/events/:eventId/stats` | section 2 |

Internal: ticket `POST /internal/admissions` `{ token, eventId, scanId, gateId, staffUserId, scannedAt }` -> `{ result, reason, ticketId,
holderName, seatLabel, tierId, usedAt, usedGate }`; ticket `GET /internal/events/:id/ticket-counts`; auth `POST /internal/users/lookup`;
booking `POST /internal/cap-transfers`, `/:id/commit`, `/:id/revert`. Existing: auth `GET /internal/users/:id`, aadhaar
`GET /internal/holders/:userId`, catalog `GET /internal/events/:id`.
Rejection reasons (closed enum in `@authentix/schemas`): `invalid_qr, qr_expired, scan_stale, wrong_event, already_used,
ticket_replaced, ticket_void, event_not_open`.

## 7. Client requirements

**My Tickets (apps/web):** list grouped by event; QR view renders with the `qrcode` package (ECC M, large quiet zone), switches token
at each corrected step boundary (`offset = serverTime - Date.now()` at fetch), shows a 30 s countdown ring, holder name, seat/tier,
"Screenshots won't scan". Refetch at <=2 remaining tokens and on `visibilitychange`. 409 used -> "Used at {time}, {gate}"; 404 ->
drop from list. Transfer dialog: email field, confirm step stating "2 transfers per ticket, none in the last 24 h", per-request
Idempotency-Key (D38 rules), neutral error copy for `recipient_not_eligible`. Never put tokens in URLs, storage or logs.

**Scanner (new `apps/scanner`, Vite + React + Tailwind, mobile-first):** staff login via `/api/auth/login` (non-staff role -> "This
account can't scan"), event picker from public `GET /api/catalog/events` filtered to the open window, a gate name field (saved in
localStorage). Camera: `getUserMedia({ video: { facingMode: 'environment' } })`; `BarcodeDetector` when available, else `jsqr` on a
canvas at ~8 fps. Ignore the same decoded text for 3 s. Each capture gets `scanId = crypto.randomUUID()` and corrected `scannedAt`.
Full-screen green (holder name, seat) or red (reason text, plus time and gate for `already_used`) for 2.5 s, with a vibration
pattern. A manual "paste token" field for demos. **Retry queue** (localStorage): on network error or 503, keep `{ scanId, eventId,
gateId, token, scannedAt }`, show amber "No connection, retrying", retry with backoff (1, 2, 4, 8 s) up to 120 s, then drop the
entry with "Rescan needed"; late results appear in a "Recent scans" list. No offline admission (open question 2). Live count polls
stats every 5 s. Tokens may sit in localStorage only while queued and are deleted on result.
**Build/serve:** parameterise `infra/Dockerfile.web` with `ARG APP=web` (build `@authentix/$APP`, copy `apps/$APP/dist`); compose
service `scanner` on `8081:80`, same nginx conf. Tailwind config imports `../web/src/design/tokens.js` (no new package).
Camera needs a secure context: `localhost` works; a phone over LAN needs HTTPS (open question 5).

## 8. Tests (only these)

ticket-service, `test/qr.test.js` (no infra): step boundary (`29_999` vs `30_000` ms change step); accept s-1, s, s+1; reject s-2,
s+2; flip one byte in each field -> `invalid_qr`; wrong master key; token for version 1 checked against version 2 -> `invalid_qr`;
bad length, bad base64, bad format byte -> `invalid_qr`; `scannedAt` older than grace -> `scan_stale`; future `scannedAt` clamped.
ticket-service, `test/admission.test.js` (scratch PG): valid -> admitted; 20 parallel admissions of one token with different scanIds
-> exactly 1 admitted, 19 `already_used` with usedAt/gate; same scanId resubmitted -> admitted again, `used_scan_id` unchanged;
wrong event; previous-step token after admission -> `already_used`; after transfer: old token -> `ticket_replaced`, new token
admitted; void -> `ticket_void`.
ticket-service, `test/transfer.test.js` (scratch PG, fake auth/aadhaar/catalog/booking clients): happy path (owner, version, count,
history row, outbox row); third transfer -> `transfer_limit_reached`; <24 h -> `transfer_window_closed`; unknown, unverified,
cap-full recipient -> identical 422 body; self -> `cannot_transfer_to_self`; parallel transfer + admission -> exactly one wins and a
losing transfer ends `failed` with revert called; two parallel transfers -> one done, one 409; reserve times out -> sweeper reverts;
commit fails -> sweeper commits; idempotent replay; `order.confirmed` handler run twice -> same tickets, one `ticket.issued`.
booking-service, `test/cap-transfer.test.js` (scratch PG): cap 4, recipient at 2, 5 parallel reserves -> exactly 2; commit twice ->
sender decremented once; revert of unknown id then reserve -> stays reverted; revert after commit -> 409.
gate-service, `test/scan.test.js` (scratch PG, fake ticket client): same scanId twice -> one row, identical body; different payload
same scanId -> 422; non-staff -> 403; ticket-service down -> 503, no row; `event_not_open`.
Consumer helper: manual check only (needs RabbitMQ): stop ticket-service, confirm an order, start it, ticket appears; kill auth,
watch retries via the management UI, restore, ticket appears.

**Never log:** QR tokens, `QR_MASTER_KEY` and derived secrets, holder keys, recipient emails, names and `holder_display`, JWTs,
`x-internal-token`, `DEMO_STAFF_PASSWORD`. Log ticket ids, transfer ids, scan ids, outcomes.

## Open questions (please decide)

1. Token batch of 5 minutes (works with weak signal) vs fetch every 30 s (smaller window if a phone is compromised). I chose 5 min.
2. No offline admission: if the scanner cannot reach the server it shows amber and retries for 120 s. True offline needs secrets on
   staff devices. OK for v1?
3. Staff scoping: any staff user, any event in its open window (start -6 h to +12 h). Should `admin` also scan? Per-event
   assignment would wait for Phase 8.
4. Folding "recipient's cap is full" into `recipient_not_eligible` protects privacy but confuses honest users. Keep?
5. Phone camera over LAN needs HTTPS. Demo on a laptop at `localhost:8081`, or add a self-signed TLS proxy?
6. Residual scalper path: payment for a transfer happens off-platform, and releasing the sender's cap lets one buyer act as a
   funnel to many verified friends. Each recipient's cap still binds. Phase 8 anomaly flag on outgoing-transfer volume?
7. A rejected-then-retried scan with the same scanId where the 120 s grace passes between attempts could audit `scan_stale` while
   an earlier racing attempt admitted. Very rare; accepted unless you object.

## Implementation checklist (each step independently checkable)

1. `init.sql`: `ticket`, `gate` (create by hand on the dev volume). `.env.example`: `QR_MASTER_KEY`, `SCAN_GRACE_SECONDS`,
   `DEMO_STAFF_PASSWORD`. Check: `psql -l`.
2. `packages/events`: `startConsumer` + `PermanentError` (section 3). Check: lint; manual check deferred to step 6.
3. Contracts `ticket.issued`, `ticket.transferred` + Zod mirrors + rejection-reason enum in `@authentix/schemas`.
4. Auth: `POST /internal/users/lookup`; staff seed script wired into root `pnpm seed`. Check: curl with and without the token; login as staff.
5. Gateway: `tickets`/`gate` routes, `ROLE_RULES`, transfer rate-limit bucket. Check: attendee JWT on `/api/gate/x` -> 403.
6. ticket-service skeleton: schema, healthz/readyz, outbox relay, consumer issuing tickets, `GET /tickets`, `GET /tickets/:id`.
   Check: book via web, ticket rows appear; restart replays nothing new.
7. QR module (`src/qr.js`: derive, encode, verify, pure) + `qr.test.js`. Must pass before continuing.
8. `GET /tickets/:id/qr`, `POST /internal/admissions`, ticket-counts + `admission.test.js`.
9. booking: `cap_transfers` + three internal routes + `cap-transfer.test.js`.
10. ticket-service transfers: route, Tx1/Tx2, sweeper + `transfer.test.js`.
11. gate-service: schema, scans, stats + `scan.test.js`.
12. Compose: ticket-service, gate-service (no published ports), gateway URLs; `scripts/check.sh` covers them.
13. Web My Tickets: list, QR view with rotation and drift correction, transfer dialog.
14. `apps/scanner` + Dockerfile.web `APP` arg + compose `scanner` on 8081.
15. Append D39-D44 to `docs/decisions.md`; walk the demo by hand: book, show QR, transfer to a second fictional user, old QR red
    `ticket_replaced`, new QR green, rescan red `already_used`, attendee JWT on the scanner API -> 403.
