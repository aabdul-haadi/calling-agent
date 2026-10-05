# MASTER PROMPT — Agent Delivery Kit

> Paste this whole file into your coding agent (or save it in the repo root as `MASTER_PROMPT.md` and tell the agent to follow it).
> Then say: **"Start Phase 0."** After each phase, review, run it yourself, then say **"Start Phase N."**

---

## 1. Your role

You are a senior full-stack TypeScript engineer and product designer. You will build a portfolio project called **Agent Delivery Kit**, one phase at a time.

You must:

- Build **only the current phase**. Never jump ahead.
- At the end of every phase, **stop** and give me the Phase Report (section 12). Wait for me to say "Start Phase N" before continuing.
- Write code that a mid-level engineer can read and explain in an interview. Clear beats clever.
- Explain every important decision in plain English in `docs/LEARNING.md` (section 11). I must be able to explain this project line by line.

---

## 2. What we are building

A small system for launching AI customer-support agents for **multiple clients** from **one shared engine**. A new client is added mostly by writing a config folder, not by changing the engine.

We prove it with two fictional clients:

| Client | Fictional brand           | What the agent does                                                                                                          | Channels             |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A      | **SkyLink Air** (airline) | Verify passenger, find booking, explain policy with citations, offer alternative flights, rebook safely, hand off to a human | Chat + browser voice |
| B      | **NovaTel** (telecom)     | Verify customer, explain bill, check outage by area, transfer cancellation requests to a human                               | Chat                 |

Both clients use the same agent engine, shared tool library, knowledge search, handoff system, logging and test runner. Only the client config folder differs.

**Use fictional brands only.** No real company names, logos or trademarks anywhere in the app or data.

---

## 3. Non-negotiable rules

### Safety and security

1. **No real data.** All customers, bookings, bills and policies are fake, generated seed data.
2. **Secrets only in `.env`.** Create `.env.example` with placeholder values. Add `.env` to `.gitignore`. Never print secrets in logs or the UI.
3. **Business rules live in code, not prompts.** Example: "no booking tools before verification" is enforced in the tool dispatcher, not only in the system prompt.
4. **Every tool input is validated** with zod before execution. Every external API response is validated before being used.
5. **Write actions are idempotent.** `change_flight` and similar tools require an idempotency key; a repeated request must never double-book.
6. **Webhooks are signed** (HMAC SHA-256) and verified with a timing-safe comparison. Duplicate events are ignored.
7. **No PII in logs.** Mask names, phone numbers, emails and booking references in logs (e.g. `SK***92`).
8. **Prompt-injection resistance.** User text is untrusted. The agent can only call allow-listed tools; it never builds raw URLs or HTTP requests.
9. **Max agent loop iterations = 6** per user turn. After that, the agent apologises and hands off to a human.
10. **Safe commands only.** Do not run destructive shell commands (`rm -rf` outside the project, force pushes, dropping databases other than the project's own dev DB). Ask me before installing anything globally.

### Engineering

- TypeScript `strict: true`. No `any` (use `unknown` + zod parsing).
- Small files (aim < 200 lines). One responsibility per file.
- Errors are returned as typed results (`{ ok: false, error: 'UNAVAILABLE' }`), not thrown across layer boundaries.
- Structured JSON logging (pino) with a `conversationId` on every log line.
- Every phase ends with passing `pnpm lint`, `pnpm typecheck` and `pnpm test`.
- Comments explain **why**, not what.

---

## 4. Tech stack (use exactly this unless I approve a change)

| Area             | Choice                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language         | TypeScript everywhere                                                                                                                                  |
| Monorepo         | pnpm workspaces                                                                                                                                        |
| Backend          | Node.js 20+, Express                                                                                                                                   |
| Frontend         | React + Vite + TypeScript, Tailwind CSS, shadcn/ui, lucide-react icons, Framer Motion (subtle only)                                                    |
| Validation       | zod                                                                                                                                                    |
| Database         | PostgreSQL 16 + pgvector (via `docker-compose`)                                                                                                        |
| ORM / migrations | Drizzle ORM                                                                                                                                            |
| LLM              | Provider abstraction supporting Anthropic and OpenAI, chosen by `LLM_PROVIDER` env var. Model name from `LLM_MODEL`. Use native tool/function calling. |
| Embeddings       | Provider abstraction, `EMBEDDING_PROVIDER` env var                                                                                                     |
| Voice            | Browser Web Speech API (speech-to-text) + `speechSynthesis` (text-to-speech). No paid voice service.                                                   |
| Tests            | Vitest (unit/integration), custom eval runner (scenario tests)                                                                                         |
| Logging          | pino                                                                                                                                                   |

---

## 5. Directory structure (create exactly this)

Keep it simple: **frontend** (what you see), **backend** (the brain), **mock-services** (fake company systems), **clients** (one folder per company), plus **shared**, **docs** and **tests**. Anyone should understand the project from the top-level folder names alone.

```
agent-delivery-kit/
│
├── frontend/                       # 🖥️  THE WEBSITE — what users see (React + Vite)
│   └── src/
│       ├── pages/                  # One file per screen: Home, AgentConsole, HandoffInbox, TestDashboard, ClientConfig
│       ├── components/
│       │   ├── ui/                 # Buttons, cards, inputs (shadcn/ui)
│       │   ├── chat/               # Chat bubbles, input box, starter prompts
│       │   ├── trace/              # Live "what the agent did" timeline
│       │   ├── handoff/            # Human queue cards
│       │   ├── tests/              # Test results, score, failure panel
│       │   └── voice/              # Mic button, waveform, captions
│       ├── hooks/                  # Reusable React logic (useChat, useVoice)
│       ├── services/               # Calls to the backend API
│       └── styles/
│
├── backend/                        # 🧠 THE BRAIN — agent server (Node + Express)
│   └── src/
│       ├── server.ts               # Starts the server
│       ├── routes/                 # API endpoints: chat, conversations, tests, health
│       ├── middleware/             # Request id, error handler, rate limit
│       ├── config/                 # Environment variables (validated)
│       ├── agent/                  # The agent itself: loop, state, prompt builder
│       ├── llm/                    # Talks to the AI model (Anthropic / OpenAI)
│       ├── tools/                  # How the agent safely uses tools
│       │   ├── dispatcher/         # Validates input, checks auth + rules, runs the tool
│       │   ├── http/               # API client, retry, timeout, error mapping
│       │   ├── auth/               # Token cache for client APIs
│       │   └── security/           # HMAC signing, PII masking, idempotency
│       ├── knowledge/              # Policy search (RAG): chunk, embed, retrieve
│       ├── handoff/                # When and how to pass to a human
│       ├── evals/                  # Scenario test runner + AI judge
│       ├── database/               # Tables (Drizzle schema) + migrations
│       └── clients/                # Loads client folders and validates their configs
│
├── mock-services/                  # 🏢 FAKE COMPANY SYSTEMS — pretend APIs for testing
│   └── src/
│       ├── airline-api/            # SkyLink bookings + flights (with fake failures)
│       ├── telecom-api/            # NovaTel accounts, bills, outages
│       ├── contact-center/         # Receives handoffs, holds the human queue
│       └── seed-data/              # Fake customers, bookings, bills
│
├── clients/                        # 🏷️  ONE FOLDER PER COMPANY — add a client = add a folder
│   ├── skylink-air/
│   │   ├── client.config.ts        # Persona, journeys, rules, tools, escalation
│   │   ├── tools/                  # Connectors to this client's API
│   │   ├── knowledge/              # Policy documents (*.md)
│   │   └── scenarios/              # Test conversations (*.yaml)
│   └── novatel/                    # Same structure
│
├── shared/                         # 🔗 TYPES used by both frontend and backend
│   └── src/                        # ClientConfig schema, API response types, ToolResult
│
├── tests/                          # ✅ UNIT + INTEGRATION TESTS (mirrors backend folders)
│   ├── tools/
│   ├── agent/
│   ├── knowledge/
│   └── handoff/
│
├── docs/                           # 📚 EXPLANATIONS
│   ├── LEARNING.md                 # Plain-English explanation, updated every phase
│   ├── ARCHITECTURE.md
│   ├── ADDING_A_CLIENT.md
│   ├── DEMO_SCRIPT.md
│   └── decisions/                  # Short "why we chose this" notes
│
├── docker-compose.yml              # Database (Postgres + pgvector)
├── .env.example                    # Required settings, no real secrets
├── .gitignore
├── package.json                    # Root scripts: dev, test, lint, eval
├── pnpm-workspace.yaml             # Workspaces: frontend, backend, mock-services, shared
└── README.md
```

**Rule of thumb for where code goes:**

| If the code…                         | Put it in            |
| ------------------------------------ | -------------------- |
| Shows something on screen            | `frontend/`          |
| Makes the agent think, decide or act | `backend/`           |
| Pretends to be a company's system    | `mock-services/`     |
| Is specific to one company           | `clients/<company>/` |
| Is a type both sides need            | `shared/`            |

---

## 6. Core design

### 6.1 Client config contract

Every client exports a typed config validated by a zod schema in `shared/`:

```ts
export const skylinkAir: ClientConfig = {
  id: 'skylink-air',
  displayName: 'SkyLink Air',
  persona: {
    name: 'Ava',
    tone: 'warm, concise, calm under pressure',
    voiceStyle: 'short sentences, read numbers naturally, confirm key details back',
  },
  scope: ['flight cancellations', 'rebooking', 'baggage and change-fee policy'],
  outOfScope: ['medical advice', 'legal claims', 'loyalty points disputes'],
  journeys: [/* steps: identify intent → verify → look up → offer → confirm → act → close */],
  rules: [/* code-enforced: requiresVerification, maxFreeChanges, etc. */],
  tools: [
    'verify_customer',
    'get_booking',
    'search_alternatives',
    'change_flight',
    'transfer_to_human',
  ],
  escalation: {
    onUserRequest: true,
    maxFailedTurns: 2,
    sentimentThreshold: 'frustrated',
    alwaysEscalateIntents: ['lost_baggage_claim', 'complaint'],
  },
  knowledgeDir: './knowledge',
};
```

Adding a client = new folder in `clients/` + register it. **No engine changes.** Prove this in Phase 8.

### 6.2 Agent loop

1. Receive user message → load conversation state (verified?, current journey step, collected data).
2. Build context: persona + scope + rules summary + relevant knowledge chunks + recent history (trimmed).
3. Call LLM with the allowed tools for this client.
4. If tool call → dispatcher validates input (zod), checks auth gate, checks rules, executes, returns a small, flattened result.
5. Repeat up to 6 iterations, then respond.
6. Check handoff triggers after each turn.
7. Log every step to the trace table.

### 6.3 Tool result contract

```ts
type ToolResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error:
        | 'NOT_FOUND'
        | 'UNAUTHORIZED'
        | 'AUTH_REQUIRED'
        | 'INVALID_ARGS'
        | 'UNAVAILABLE'
        | 'RULE_BLOCKED';
      message: string;
    };
```

The agent must explain errors to the customer gracefully and never invent data when `ok: false`.

### 6.4 Database tables (minimum)

`clients`, `conversations`, `messages`, `tool_calls` (tool, input, output, status, latency_ms), `trace_events`, `handoffs`, `knowledge_chunks` (with vector embedding + source + updated_at), `idempotency_keys`, `eval_runs`, `eval_results`.

---

## 7. UI/UX requirements

### Design principles

- **Instantly understandable.** A non-technical person should understand each screen in 5 seconds.
- **Calm and modern.** Lots of whitespace, soft rounded cards (rounded-2xl), subtle shadows, one accent colour per client (SkyLink = sky blue, NovaTel = violet), neutral greys elsewhere.
- **Light and dark mode** with a toggle.
- **Accessible:** WCAG AA contrast, full keyboard navigation, visible focus rings, aria labels, `prefers-reduced-motion` respected.
- **Responsive:** works well at 375px (mobile) and 1440px (desktop).
- **Plain-language labels.** "Checked the booking system" instead of `tool_call: get_booking`. Raw JSON is available behind a "Show details" toggle.
- **Every state designed:** loading (skeletons), empty, error (with a clear next action), success.

### Screens

1. **Home / Client picker** — two large cards (SkyLink Air, NovaTel) with logo-style initials, a one-line description, and "Open agent". A small "How it works" strip: Customer → Agent → Tools → Human, in 4 simple icons.
2. **Agent Console** (main screen, 3 columns on desktop, tabs on mobile):
   - **Left:** chat with the agent (message bubbles, typing indicator, suggested starter prompts like "My flight was cancelled").
   - **Centre:** **Live Trace** — a vertical timeline of what the agent did: "Understood intent: rebooking", "Asked to verify identity", "Checked booking (320 ms)", "Found 3 alternative flights", with green/amber/red status dots and latency badges.
   - **Right:** **Conversation State** card (Verified ✓/✗, Journey step progress bar, Collected info) and **Knowledge used** (cited policy snippets with source names).
3. **Human Handoff Inbox** — looks like a simple contact-center queue: each card shows customer (masked), reason for escalation, 3-line summary, what the AI already tried, sentiment chip, and "Accept" button.
4. **Test Dashboard** — run the scenario suite per client with one button; shows a big pass score (e.g. 23/25), a list of scenarios with pass/fail chips, and a failed scenario opens a side panel with the transcript, the expected behaviour and the judge's reason.
5. **Client Config Viewer** — read-only, friendly view of the client config: persona card, journeys as step diagrams, rules as checklist items, tools as chips. Demonstrates "new client = new config".
6. **Voice mode** (SkyLink only) — a large mic button in the chat panel; animated waveform while listening; agent speech stops immediately when the user starts talking (barge-in); live captions shown.

### Simulator controls (small "Demo controls" drawer)

- Toggle "Booking API failing" (forces UNAVAILABLE to demo graceful handling).
- Slider "API latency" (0–3000 ms).
- Button "Reset conversation".

---

## 8. Phases

Each phase lists deliverables and **Done when** criteria. Do not start the next phase until I approve.

### Phase 0 — Foundation

- Monorepo, pnpm workspaces, tsconfig, ESLint + Prettier, Vitest, docker-compose (Postgres + pgvector), `.env.example`, env validation with zod.
- Empty apps that start: `pnpm dev` runs frontend, backend and mock-services.
- `docs/LEARNING.md` started.

**Done when:** `pnpm dev` starts all three apps, `/health` returns OK, DB connects, lint/typecheck/test pass.

### Phase 1 — Mock client systems + shared tool library

- Seed fake data (20 SkyLink passengers/bookings, flights; 20 NovaTel accounts/bills/outage areas).
- SkyLink mock API: token endpoint (client credentials), `GET /bookings/:ref`, `GET /flights/alternatives`, `POST /bookings/:ref/change` (requires `Idempotency-Key`). Configurable random failure rate and latency.
- Shared tool library: typed HTTP client, timeout, retry with exponential backoff + jitter (only 429/5xx/timeouts), token cache, error mapping to `ToolResult`, HMAC sign/verify, PII masking.

**Done when:** unit tests cover retry rules, idempotency (same key twice = one change), HMAC verify, PII masking.

### Phase 2 — Agent engine + SkyLink tools (text chat)

- LLM provider abstraction, agent loop, state, dispatcher with zod validation, auth gate, rule checks, loop guard.
- SkyLink config + tools: `verify_customer`, `get_booking`, `search_alternatives`, `change_flight`, `transfer_to_human` (stub).
- `POST /chat` endpoint. Every step written to `tool_calls` and `trace_events`.

**Done when:** a full rebooking works via API; booking tools are blocked before verification (tested); loop guard tested.

### Phase 3 — Knowledge search (RAG) with citations

- 10–12 short SkyLink policy docs (cancellations, rebooking, baggage, refunds, change fees).
- Ingest: chunk by heading, embed, store with source + updated_at.
- Retrieve top-k, simple rerank, inject into context, answer with citations.
- If nothing relevant is found → "I'm not sure about that" + offer human. Never improvise policy.

**Done when:** policy questions return cited answers; an unknown question returns the safe fallback (tested).

### Phase 4 — Human handoff + observability

- Handoff triggers: user asks, 2 failed turns, frustration detected, always-escalate intents, loop guard hit, tool unavailable twice.
- Summary generator (3 lines + intent + verified status + what was tried).
- Signed webhook to contact-center mock; duplicates ignored; queue stored.
- Trace API for the UI.

**Done when:** each trigger is tested; webhook rejects bad signatures and ignores duplicates.

### Phase 5 — UI/UX

- Build screens 1–3 and 5 from section 7, plus demo controls.
- Polished, responsive, accessible, light/dark, all states designed.

**Done when:** I can complete a rebooking in the UI, watch the live trace, see citations, trigger a handoff and see it arrive in the inbox. Run an accessibility check (axe) with no serious issues.

### Phase 6 — Scenario test suite + Test Dashboard

- YAML scenario format: persona, user turns, expected tools (in order), forbidden behaviours, expected outcome.
- 20 SkyLink scenarios: happy paths, unverified access attempt, prompt injection ("ignore your rules"), API down, duplicate rebooking, multi-intent, angry customer, out-of-scope, unknown policy question.
- Runner: deterministic checks (tool order, rule violations) + LLM judge for tone/accuracy with a written reason.
- Results stored in `eval_runs`/`eval_results`; Test Dashboard screen.

**Done when:** `pnpm eval skylink-air` prints a score and the dashboard shows it. Record the first-run score in `docs/LEARNING.md`, fix failures, record the improved score.

### Phase 7 — Voice mode (SkyLink)

- Browser speech-to-text and text-to-speech, mic button, waveform, live captions, barge-in, short voice-friendly replies (persona `voiceStyle`), numbers read naturally, key details confirmed back.
- Show per-turn latency (speech end → first audio) in the trace.
- Graceful fallback message if the browser doesn't support speech.

**Done when:** a full rebooking works by voice in Chrome; interrupting stops the agent's speech.

### Phase 8 — Second client: NovaTel (the reusability proof)

- New folder `clients/novatel/` with config, 3 tools (`verify_customer`, `get_bill`, `check_outage`) + `transfer_to_human` for cancellations, 5 policy docs, 8 scenarios.
- Telecom mock API in `mock-services/src/telecom-api/`.
- **Zero changes to `backend/src/agent/` or `backend/src/tools/`.** If a change seems needed, stop and explain why before making it.
- Track time spent and write `docs/ADDING_A_CLIENT.md` (step-by-step guide).

**Done when:** NovaTel works in the UI and its suite passes; `git diff` shows no engine changes.

### Phase 9 — Documentation and demo polish

- README: what it is, a 30-second pitch, architecture diagram (Mermaid), screenshots, setup in 5 commands, how to run tests, **Known limitations** (browser voice, not SIP telephony; mock APIs; small eval set; what production would add: SIP trunk + contact-center integration, real auth, monitoring, PCI/HIPAA controls).
- `docs/ARCHITECTURE.md` and ADRs (rules in code, tool result contract, idempotency, why config-driven clients).
- A 2-minute demo script in `docs/DEMO_SCRIPT.md`: rebooking → API failure handled → handoff → test dashboard → show NovaTel config.

**Done when:** a fresh clone runs with the README instructions alone.

---

## 9. Coding conventions

- Naming: `camelCase` variables, `PascalCase` types/components, `kebab-case` files.
- Each backend folder exports through a single `index.ts`.
- Dependency direction: `frontend → shared`, `backend → shared`, `clients → backend` interfaces. The frontend never imports backend code; it only calls the API.
- React: function components, hooks for logic, no business logic inside components.
- API responses always `{ data }` or `{ error: { code, message } }`.
- Git: one commit per meaningful step, conventional commit messages (`feat(core): add loop guard`).

---

## 10. Testing expectations

- Unit tests for every function in `backend/src/tools/` (including the dispatcher), kept in `tests/`.
- Integration tests for `/chat` with the LLM mocked (fixed tool-call responses), so tests are fast and deterministic.
- Scenario evals (Phase 6) run against the real LLM, separately from unit tests.
- Never mark a phase done with failing or skipped tests.

---

## 11. LEARNING.md (very important)

After every phase, append a section to `docs/LEARNING.md` in simple English:

1. What we built in this phase (3–5 sentences).
2. The 3 most important design decisions and **why** we made them.
3. One thing that could go wrong in production and how the code handles it.
4. Three interview questions someone could ask about this phase, with short model answers.
5. Files I should read first to understand this phase.

---

## 12. Phase Report format (end of every phase)

```
PHASE N REPORT
- Built: …
- Files created/changed: …
- How to run: …
- How to test: … (and results)
- Decisions made: …
- Known issues / shortcuts: …
- Anything you need from me (keys, choices): …
Waiting for approval to start Phase N+1.
```

---

## 13. When you are unsure

- If a requirement is ambiguous, choose the simplest safe option, write the assumption in the Phase Report, and continue.
- If something would break a non-negotiable rule (section 3), stop and ask.
- Do not add features not listed here. Suggest them in the Phase Report instead.

**Start with Phase 0 only.**
