# LEARNING.md — explain this project line by line

Plain-English notes, one section per phase.

---

## Phase 0 — Foundation

**What we built.** A pnpm monorepo with four workspaces (`frontend`, `backend`, `mock-services`, `shared`) plus plain folders for `clients/` and `tests/`. The backend validates its environment with zod, logs with pino, talks to Postgres through Drizzle, and exposes `/health`. The database schema (all 10 tables) is defined once and migrated with drizzle-kit generated SQL.

**Three decisions and why.**
1. *One shared `.env` in the repo root.* Backend and mock services read the same file, so there is one place for secrets and `.env.example` documents all of them.
2. *Tests use an in-process Postgres (PGlite + pgvector) instead of Docker.* Real SQL and real migrations run in tests, but anyone can run `pnpm test` without installing Docker. Production uses `docker-compose` Postgres 16 + pgvector.
3. *`@adk/shared` holds types and zod schemas only* (plus HMAC in a separate Node-only entry) so the browser bundle never imports `node:crypto`.

**What could go wrong in production.** Database is down at startup. The server still boots and `/health` reports `degraded` instead of crashing, so the UI can show a clear state.

**Interview questions.**
- *Why validate env at startup?* Fail fast with a readable message rather than crash later in a random place.
- *Why pgvector rather than a separate vector DB?* One datastore, transactional, plenty for thousands of policy chunks.
- *Why Drizzle?* Typed SQL close to the metal, migrations are plain SQL files you can review.

**Read first.** `backend/src/config/env.ts`, `backend/src/database/schema.ts`, `backend/src/app.ts`.

---

## Phase 1 — Mock company systems + shared tool library

**What we built.** Fake airline, telecom and contact-center APIs (deterministic seed data, OAuth token endpoint, random failures and latency). In the backend, a typed HTTP client with timeouts, retry with exponential backoff and jitter, a token cache, error mapping into `ToolResult`, HMAC signing and PII masking.

**Three decisions and why.**
1. *Retry only 429/5xx/timeouts, and only POSTs that carry an Idempotency-Key.* Retrying a wrong request never helps, and retrying a write without a key could double-book.
2. *Idempotency is enforced on both sides.* The mock API replays the first answer for a repeated key; the backend derives the key from (conversation, booking, flight) so a repeat from the model produces the same key.
3. *Errors are values (`ToolResult`).* The agent loop always gets a typed answer it can explain to the customer.

**What could go wrong.** The upstream returns 200 with a garbage body. Every response is parsed with zod; invalid bodies become `UNAVAILABLE`, never trusted data.

**Interview questions.**
- *What is jitter for?* Stops many clients retrying at the exact same moment (thundering herd).
- *How do you stop double-booking?* Idempotency key on the write; server stores first result by key.
- *Why compare signatures with `timingSafeEqual`?* A normal comparison leaks how many leading bytes matched through timing.

**Read first.** `backend/src/tools/http/api-client.ts`, `mock-services/src/airline-api/index.ts`, `tests/tools/`.
