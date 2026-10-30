# Authentix: Build Instructions for Claude Code

Authentix is a concert and festival ticket booking platform that uses Aadhaar-based identity verification to stop scalpers from hoarding and reselling tickets. This is a university full-stack project. Build it as a clean, demo-ready microservices system.

## How to work

- Build in the phases listed at the bottom, one phase at a time. At the end of each phase, stop, summarise what works, and wait for my go-ahead.
- Before starting a phase, give me a 5-line plan. Do not start large refactors or extra work I did not ask for.
- Keep every service small, validated at its boundaries, and runnable on its own. Prefer boring, well-known libraries.
- Everything must run locally with a single `docker compose up`.
- Write tests only for the critical paths listed in "Testing". No blanket test suites. Follow the self-check loop below after every task.
- Commit after each working milestone with a clear message.

## Model routing (Sonnet does the work, Opus only for hard tasks)

- The main session runs on **Sonnet** (set in `.claude/settings.json`). Do all routine work yourself: services, CRUD, UI, tests, config, docs.
- Delegate to the **`architect`** subagent (Opus) only for hard tasks: cross-service design, seat holds and double-booking prevention, the booking saga and payment idempotency, Aadhaar hashing and rotating-QR security, data-model decisions, and any bug that two fix attempts have not solved.
- Preferred pattern: `architect` writes a short decision note and step-by-step plan, then you (Sonnet) implement it. `architect` writes code only for correctness-critical logic.
- Do not use Opus for formatting, boilerplate, styling, or simple fixes. When in doubt, stay on Sonnet.
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL` (it would override the per-agent models), and do not use the `opusplan` alias with this setup.

## Self-check loop (mandatory after every task)

After you finish any task, do not stop and do not declare it done. Run this loop:

1. **Check:** run `scripts/check.sh` (lint, tests, build for everything that exists).
2. **Verify:** call the `verifier` subagent with the task's acceptance criteria. It returns `VERDICT: PASS` or `FAIL` with specific failures.
3. **Fix:** if either step fails, fix the listed failures, then go back to step 1.
4. **Escalate:** if the same failure survives 2 attempts, call the `architect` subagent for diagnosis, then continue the loop.
5. **Stop conditions:** exit the loop when `scripts/check.sh` passes and the verifier says PASS. Maximum **3 full iterations** after the first attempt; if still failing, stop and report what is failing, what you tried, and your best hypothesis. Do not loop forever and do not hide failures.
6. **Report:** finish with a short summary: what was built, check results, any known gaps.

A Stop hook (`.claude/hooks/stop-check.sh`) also runs `scripts/check.sh` automatically whenever files changed and sends failures back to you, as a safety net. Keep `scripts/check.sh` up to date as new services are added (Phase 1 task: confirm it works with the real repo layout).

## Hard rules (privacy and safety)

- **Never use real Aadhaar numbers, OTPs, or any real personal data.** All data in code, seeds, fixtures, and docs is fictional. Use the mock UIDAI service only.
- Never store a raw Aadhaar number. Store only a salted hash (HMAC-SHA256 with a server-side secret) plus the last 4 digits for display. The hash is what enforces "one Aadhaar = one account" and per-event ticket limits.
- Never log OTPs, Aadhaar numbers, tokens, or payment details.
- Secrets live in `.env` files (git-ignored). Provide `.env.example` only.

## Tech stack

- **Languages:** JavaScript (Node 20+, ES modules) for all backend services except chatbot-service, which is **Python 3.11+**. Use JSDoc type hints in JS code for editor support.
- **Backend framework:** Fastify (or Express if you prefer). Zod for request validation.
- **Frontend:** React + Vite + JavaScript (JSX) + Tailwind CSS. Three apps: customer web, staff scanner, admin dashboard.
- **Database:** PostgreSQL, **one database (schema) per service**. No service reads another service's tables.
- **Cache, holds, queue:** Redis.
- **Async messaging:** RabbitMQ (or NATS). Use events for cross-service updates.
- **Chatbot (Python):** FastAPI + Pydantic. RAG over event/FAQ documents using pgvector (inside its own Postgres) and the **Gemini API** via the current **`google-genai`** SDK (`from google import genai`; do NOT use the deprecated `google-generativeai` package). Own Dockerfile and `requirements.txt` (or `uv`). Key is `GEMINI_API_KEY` from env, never hard-coded. Read the current Gemini docs (ai.google.dev) before coding, and make the chat model name and the embedding model name env variables (`GEMINI_CHAT_MODEL`, `GEMINI_EMBED_MODEL`) so they are easy to change. Handle rate limits and missing-key errors gracefully (friendly fallback message, never a crash). Never put Aadhaar data or other personal data into prompts.
- **Monorepo:** pnpm workspaces for the JS code; the Python service lives in the same repo with its own dependency file. Shared JS packages: `@authentix/schemas` (Zod), `@authentix/events`, `@authentix/logger`.
- **Cross-language contracts:** event payloads and service APIs are defined as JSON Schema / OpenAPI files in `contracts/`. JS (Zod) and Python (Pydantic) models must match them, so the Python chatbot and JS services never drift apart.
- **API docs:** each service exposes an OpenAPI spec. Generate typed clients from it where useful.

## Repository layout

```
authentix/
  apps/
    web/                 # customer app
    scanner/             # gate staff web app (mobile-first, camera QR scan)
    admin/               # organiser/admin dashboard
  services/
    api-gateway/
    auth-service/
    aadhaar-service/
    mock-uidai/          # fake UIDAI, separate container, dev only
    catalog-service/
    inventory-service/   # seats, GA stock, holds
    queue-service/       # virtual waiting room
    booking-service/     # orders, saga coordinator
    payment-service/     # mock gateway
    ticket-service/      # issue, rotating QR, transfer
    notification-service/
    chatbot-service/     # Python (FastAPI)
    gate-service/        # entry validation
  packages/
    schemas/ events/ logger/
  contracts/             # JSON Schema + OpenAPI shared by JS and Python
  infra/
    docker-compose.yml
  docs/
    architecture.md  api-contracts.md
  CLAUDE.md
```

## Services and their responsibilities

| Service | Owns | Notes |
|---|---|---|
| **api-gateway** | Routing, JWT verification, rate limiting, CORS, request IDs | Only public entry point. Services are not exposed directly. |
| **auth-service** | Users, login, sessions, roles (`attendee`, `staff`, `organiser`, `admin`) | Short-lived access JWT plus refresh token. Passwords hashed with argon2. |
| **aadhaar-service** | Aadhaar verification status per user | Calls mock-uidai for OTP send/verify. Stores salted hash and last 4 only. Rejects a second account using the same hash. Emits `user.verified`. |
| **mock-uidai** | Fake UIDAI API | Accepts fictional test Aadhaar numbers from a seed list. Fixed demo OTP in dev mode. Simulates failures and delays. |
| **catalog-service** | Events, venues, artists, categories, search | Public reads, organiser writes. Includes city and category filters. |
| **inventory-service** | Seat maps, GA stock, **seat holds** | Holds use Redis with TTL (e.g. 8 minutes). Postgres is the source of truth for sold seats. No double-selling, ever. |
| **queue-service** | Virtual waiting room for hot sales | Redis sorted set. Admits users in batches. Issues a short-lived admission token required by the booking flow. |
| **booking-service** | Orders and the checkout saga | Orchestrates: hold, pay, issue. Enforces per-Aadhaar ticket limit per event. Compensates on failure (release hold, refund). |
| **payment-service** | Mock payments | Fake card/UPI flow, idempotent, with simulated success, failure, and timeout. Webhook-style callback to booking-service. |
| **ticket-service** | Tickets, QR, transfers | Rotating signed QR (see below). Transfer-to-friend only; no resale or price change. |
| **notification-service** | Email/SMS/in-app | Consumes events. Use a console/mailhog sink in dev. |
| **chatbot-service** (Python) | RAG help bot | Answers booking help and FAQs from indexed docs. Cites the source doc. Refuses to guess about prices or availability; calls catalog-service for live data instead. |
| **gate-service** | Entry validation | Verifies QR signature, checks ticket not already used, marks used atomically. Works for staff role only. |

## Core flows

1. **Sign-up and verification:** register, verify email, Aadhaar OTP via mock-uidai, `user.verified` event. Only verified users can book.
2. **Browse:** catalog pages, search, filters, event detail with seat map or GA tiers.
3. **Hot-sale queue:** for flagged events, user joins the waiting room, sees position and estimated wait, receives an admission token, then enters booking.
4. **Booking saga:** select seats, inventory places hold, booking creates order, payment-service charges, booking confirms, inventory marks sold, ticket-service issues tickets, notification sends confirmation. Any failure releases holds and refunds.
5. **Transfer:** owner transfers a ticket to another **verified** user by email or phone. Ticket is re-issued to the new holder (new QR, old one invalidated). Transfer limits apply. No resale.
6. **Entry:** staff scans QR, gate-service validates, shows green or red with the reason.

## Anti-scalper rules (the core of the product)

- One Aadhaar hash maps to one account. Enforce with a unique constraint.
- Per-event ticket cap per Aadhaar hash (configurable by organiser, default 4).
- Ticket is bound to the verified holder's name (first name and last initial shown at the gate).
- Transfers only to verified users, capped in count, with a cooling period near the event.
- Rate limits and anomaly flags: many failed OTPs, many bookings from one device/IP, rapid transfer chains. Flag to admin dashboard; do not auto-ban in v1.
- **Rotating QR:** the QR encodes a signed token that changes every 30 seconds (TOTP-style with a per-ticket secret). Screenshots become useless.

## Reliability patterns (apply from the start)

- **Idempotency keys** on all mutating booking and payment endpoints.
- **Outbox pattern** for events: write the event to an outbox table in the same DB transaction, then publish. No lost or phantom events.
- **Saga with compensation** in booking-service (no distributed transactions).
- **Optimistic locking or `SELECT ... FOR UPDATE SKIP LOCKED`** for seat sales.
- Health endpoints (`/healthz`, `/readyz`) on every service.
- Structured JSON logs with a request ID that flows through the gateway and all services.
- Timeouts and retries with backoff on every service-to-service call.

## Design: reference is district.in

Use **district.in (District by Zomato)** as the visual and UX reference. Do not copy its assets, logos, text, or code; recreate the *patterns* with original branding for Authentix.

Before designing, inspect the live site visually (Claude in Chrome, or screenshots I will provide in `docs/design-refs/`). Extract the real spacing, typography scale, colour usage, card styles, and motion from it. Do not guess values. Save the extracted tokens in `apps/web/src/design/tokens.js` and Tailwind config.

Patterns to reproduce:

- **Top bar:** logo, **location selector**, prominent **search bar** ("Search for events, artists and venues"), and category tabs: **For you, Concerts, Festivals, Comedy** (adapt from District's For you / Dining / Movies / Events / Comedy).
- **Home page** is a stack of **horizontal scroll carousels**, each with a section title:
  - "Artists in your city" (circular avatar chips)
  - "Concerts near you"
  - "Festivals this season"
  - "Laugh out loud" (comedy)
  - "Explore music events near you"
- **Event card:** poster image, event title, venue, distance from user, date and time range. Clean, image-led, minimal chrome.
- **Event detail page:** hero poster, date/time/venue block, about section, ticket tiers or seat map, sticky "Book tickets" CTA.
- **Footer:** social links, help, quick links ("List your event"), legal links, app download area.
- Mobile-first, fast, lots of white space, rounded cards, smooth horizontal scrolling. Support light and dark themes.
- Authentix-specific additions: a **"Verified entry"** badge on events, an Aadhaar verification step in onboarding, and a clear queue/waiting-room screen.

Accessibility: semantic HTML, keyboard navigation, visible focus states, WCAG AA contrast, alt text on all images.

## Screens to build

**Customer web:** home, search results, event detail, seat selection (SVG seat map for reserved seating plus quantity picker for GA), waiting room, checkout, payment, booking confirmation, My Tickets (rotating QR, transfer action), profile and verification status, chatbot widget.

**Scanner app:** staff login, event selector, camera QR scanner, big green/red result screen with reason, offline-tolerant retry, live entry count.

**Admin dashboard:** create/edit events and seat maps, ticket caps, sales and entry stats, flagged-account list.

## Seed data and demo mode

- Seed 15 to 20 fictional events across Delhi NCR, Mumbai, and Bengaluru with original (or placeholder) poster images. No real artists' copyrighted material.
- A `pnpm seed` command that loads events, a venue seat map, test users, and the mock Aadhaar list.
- A demo script in `docs/demo.md`: sign up, verify, hit the queue, book, transfer, scan at the gate, show a blocked scalper attempt.

## Testing (only these)

- Seat hold and double-booking race test (many concurrent buyers, one seat).
- Booking saga failure paths (payment fails, hold expires).
- Aadhaar uniqueness and per-event cap enforcement.
- QR rotation and one-time entry validation.

## Phases

1. **Foundation:** monorepo, docker-compose (Postgres, Redis, RabbitMQ), shared packages, api-gateway, auth-service, health checks, logging.
2. **Identity:** mock-uidai, aadhaar-service, verification flow, one-Aadhaar-one-account rule.
3. **Catalog and web shell:** catalog-service, seed data, customer web home/search/detail pages matching the District-style design.
4. **Inventory and booking:** inventory-service with holds, booking-service saga, payment-service mock, checkout UI.
5. **Tickets and entry:** ticket-service with rotating QR and transfers, gate-service, scanner app, My Tickets UI.
6. **Waiting room:** queue-service and waiting-room UI.
7. **Chatbot and notifications:** chatbot-service (Python, RAG), notification-service.
8. **Admin, hardening, demo:** admin dashboard, anomaly flags, rate limits, the four tests, README, architecture diagram, demo script.

Start with Phase 1 now. Show me the 5-line plan first.
