# Agent Delivery Kit

**Launch AI customer-support agents for many companies from one shared engine. A new client is a config folder, not a code change.**

Two fictional clients prove it: **SkyLink Air** (airline: verify, rebook a cancelled flight, policy answers with citations, human handoff, browser voice) and **NovaTel** (telecom: explain a bill, check outages, send cancellations to a human). All brands, customers and data are fake.

## The 30-second pitch

Most "AI agent" demos are one prompt glued to one API. Real delivery work means doing it again for the next client, safely. This project separates the **engine** (agent loop, tool dispatcher, knowledge search, handoff, logging, test runner) from the **client folder** (persona, journeys, rules, tools, policies, test scenarios). Business rules such as "no booking tools before verification" are enforced **in code**, not just in the prompt, and every behaviour is covered by deterministic tests and a scenario suite with an LLM judge.

## Architecture

```mermaid
flowchart LR
  C[Customer<br/>chat or voice] --> FE[Frontend<br/>React console]
  FE -->|POST /chat| BE[Backend<br/>Express]
  subgraph Engine
    BE --> L[Agent loop<br/>max 6 steps]
    L --> LLM[LLM provider<br/>Anthropic or OpenAI]
    L --> D[Tool dispatcher<br/>allow-list, zod, auth gate, rules]
    L --> K[Knowledge search<br/>pgvector RAG]
    L --> H[Handoff<br/>signed webhook]
  end
  D --> T[Client tools<br/>clients/skylink-air, clients/novatel]
  T -->|OAuth, retry, idempotency| M[Mock company systems]
  H -->|HMAC-SHA256| M
  BE --- DB[(Postgres + pgvector)]
```

| Folder           | What it is                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/`      | The website: client picker, Agent Console (chat + live trace + state + knowledge), Handoff Inbox, Test Dashboard, Client Config viewer, voice mode |
| `backend/`       | The brain: agent loop, dispatcher, LLM adapters, RAG, handoff, evals, database                                                                     |
| `mock-services/` | Fake company systems: airline API, telecom API, contact center                                                                                     |
| `clients/`       | One folder per company: config, tools, policy docs, test scenarios                                                                                 |
| `shared/`        | Types and schemas used by both sides                                                                                                               |
| `tests/`         | Unit and integration tests (LLM mocked, in-process Postgres)                                                                                       |
| `docs/`          | Architecture, ADRs, how to add a client, demo script, LEARNING.md                                                                                  |

## Setup in 5 commands

Requires Node 20+ and pnpm 9. Docker is **optional** (see "Choosing a database" below).

```bash
pnpm install
cp .env.example .env            # then set ANTHROPIC_API_KEY (or OPENAI_API_KEY + LLM_PROVIDER=openai)
docker compose up -d            # Postgres 16 + pgvector (skip if you use a local or hosted database)
pnpm db:migrate                 # creates the tables (the backend also migrates on start)
pnpm dev                        # frontend :5173, backend :4000, mock systems :4100
```

### Choosing a database

Set `DATABASE_URL` in `.env`:

| Option                 | `DATABASE_URL`                              | Notes                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Postgres        | `postgres://adk:adk@localhost:5432/adk`     | Default in `.env.example`. Run `docker compose up -d`.                                                                                                                                                                                 |
| Local, zero install    | `pglite:.pglite/data`                       | Postgres + pgvector running inside Node, saved to a folder. No Docker. **One process at a time**: stop `pnpm dev` before running `pnpm eval` (a lock file refuses a second process).                                                   |
| Hosted (e.g. Supabase) | `postgresql://...` plus `DATABASE_SSL=true` | Use the **Postgres connection string** (not the REST/API keys). On networks without IPv6 use the **session pooler** host. Percent-encode special characters in the password (`#` → `%23`, `$` → `%24`). Enable the `vector` extension. |

Open <http://localhost:5173>. Try booking **SK1001**, last name **Rahman** (flight cancelled, alternatives available). NovaTel: account **NT2002**, last name **Alvarez** (bill is higher because of roaming). More fake customers are in `mock-services/src/seed-data/`.

If the configured database is unreachable, the backend still starts and reports `/health` as `degraded` instead of crashing.

## The operations console (UI)

Open <http://localhost:5173>. The dark theme is the default; the toggle in the top bar switches to light.

| Page           | Route              | What it shows                                                                                        |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| Overview       | `/`                | Conversations, handoffs, approvals, tool outcomes and latency, eval pass rate, recent activity       |
| Agent Console  | `/agent/:tenant`   | Chat with a live 3D agent, inline citations, approval card, live trace, state, audit log             |
| Traces         | `/traces`          | Any conversation, turn by turn, with search, filters, expandable JSON and the audit log              |
| Human Handoffs | `/handoffs`        | Queue and filters, reason, summary, conversation, **accept, reply to the customer, resolve**         |
| Evaluations    | `/evaluations`     | Run a suite, per-category pass rates, run-to-run comparison, expected vs actual, judge kept separate |
| Knowledge      | `/knowledge`       | The policy documents the agent can cite                                                              |
| Tenants        | `/tenants/:tenant` | Persona, tools, rules, escalation, journeys, validation, runtime status (change controls disabled)   |
| Voice Lab      | `/voice`           | Browser voice with a mic-driven waveform, mute, stop, disconnect, transcript                         |
| Architecture   | `/architecture`    | The turn lifecycle, phases, security principles, stack and limits                                    |

`Ctrl/Cmd + K` opens a command palette. The tenant selector in the top bar scopes every page.

**What the UI does not pretend.** Numbers come from stored records; token usage and cost are shown as "Not recorded" because they are not recorded. The backend answers a turn in one response, so tool activity is replayed right after the reply and the UI says so. The agent's speaking animation is a pattern (browser speech audio cannot be analysed), while the listening waveform follows the real microphone level. Save, publish and roll back for configuration are disabled because configuration lives in files.

**The 3D agent** (`frontend/src/agent3d/`) uses `three` and `@react-three/fiber`. It is lazy-loaded as its own chunk, pauses when off-screen or the tab is hidden, uses fewer particles on small screens, shows a static fallback when WebGL is unavailable or the user prefers reduced motion, and its state comes only from real signals (`deriveAgentMode`). A text caption always states the state, so it never depends on the visual.

New read-only backend endpoints that feed it: `GET /overview`, `GET /conversations`, `GET /conversations/:id/audit`, `GET /clients/:id/knowledge`.

## Running tests

```bash
pnpm test        # 185 backend/integration tests + 88 frontend tests (incl. axe accessibility + WCAG contrast)
pnpm typecheck
pnpm lint
pnpm eval skylink-air     # scenario suite against the REAL LLM (needs an API key and `pnpm dev` mock services running)
pnpm eval novatel
```

Unit tests never call a real model or Docker: the LLM is scripted and Postgres runs in-process (PGlite with pgvector). The scenario evals are separate because they use the real model.

## Safety by design

Fake data only · secrets only in `.env` · tool inputs validated with zod · external responses validated · writes are idempotent · webhooks signed (HMAC SHA-256, timing-safe, replay window, duplicates ignored) · PII masked in logs, traces and the inbox · prompt-injection resistant (untrusted text, allow-listed tools, no raw URLs) · hard cap of 6 loop iterations then hand off.

## Known limitations

- **Voice is browser speech (Web Speech API), not telephony.** Chrome/Edge only; speech recognition may send audio to the browser vendor. Production voice would use a SIP trunk and a contact-center platform.
- **Mock APIs.** The company systems are simulations with fake failures; real systems bring auth, rate limits and data quirks.
- **Small eval set** (20 SkyLink + 8 NovaTel scenarios, scripted customer turns, LLM judge). It catches regressions, it is not statistical proof of quality.
- **Local embeddings are lexical.** The default `EMBEDDING_PROVIDER=local` hashes words (no key needed). Use `openai` for real semantic search.
- **Barge-in relies on browser echo cancellation**; on speakers without it the agent may interrupt itself.
- **No screenshots are committed**; run the app to see the UI.
- **No streaming.** A turn is answered in one response, so the live trace and tool activity appear after the reply.
- **No login or user accounts.** Anyone who can reach the UI can see every conversation. Do not expose it as is.
- **3D agent cost.** Its chunk is about 900 kB (240 kB gzipped) and loads only when an agent view opens. `@react-three/fiber` currently triggers a harmless `THREE.Clock` deprecation warning in the browser console.
- **What production would add:** SIP trunk + contact-center integration, real customer authentication (not booking ref + last name), monitoring and alerting, rate limiting on a shared store, PCI/HIPAA controls where payments or health data are involved, and a much larger evaluation set.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Adding a client](docs/ADDING_A_CLIENT.md) · [Demo script](docs/DEMO_SCRIPT.md) · [Decisions (ADRs)](docs/decisions/) · [LEARNING.md](docs/LEARNING.md)
