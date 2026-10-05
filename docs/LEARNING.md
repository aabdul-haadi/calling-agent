# LEARNING.md — explain this project line by line

Phases 2-9 were built in one go (the master prompt asks for a stop and approval after each phase; the request was to build the whole project, so the phase reports were merged into the final report).

Plain-English notes, one section per phase.

---

## Phase 0 — Foundation

**What we built.** A pnpm monorepo with four workspaces (`frontend`, `backend`, `mock-services`, `shared`) plus plain folders for `clients/` and `tests/`. The backend validates its environment with zod, logs with pino, talks to Postgres through Drizzle, and exposes `/health`. The database schema (all 10 tables) is defined once and migrated with drizzle-kit generated SQL.

**Three decisions and why.**

1. _One shared `.env` in the repo root._ Backend and mock services read the same file, so there is one place for secrets and `.env.example` documents all of them.
2. _Tests use an in-process Postgres (PGlite + pgvector) instead of Docker._ Real SQL and real migrations run in tests, but anyone can run `pnpm test` without installing Docker. Production uses `docker-compose` Postgres 16 + pgvector.
3. _`@adk/shared` holds types and zod schemas only_ (plus HMAC in a separate Node-only entry) so the browser bundle never imports `node:crypto`.

**What could go wrong in production.** Database is down at startup. The server still boots and `/health` reports `degraded` instead of crashing, so the UI can show a clear state.

**Interview questions.**

- _Why validate env at startup?_ Fail fast with a readable message rather than crash later in a random place.
- _Why pgvector rather than a separate vector DB?_ One datastore, transactional, plenty for thousands of policy chunks.
- _Why Drizzle?_ Typed SQL close to the metal, migrations are plain SQL files you can review.

**Read first.** `backend/src/config/env.ts`, `backend/src/database/schema.ts`, `backend/src/app.ts`.

---

## Phase 1 — Mock company systems + shared tool library

**What we built.** Fake airline, telecom and contact-center APIs (deterministic seed data, OAuth token endpoint, random failures and latency). In the backend, a typed HTTP client with timeouts, retry with exponential backoff and jitter, a token cache, error mapping into `ToolResult`, HMAC signing and PII masking.

**Three decisions and why.**

1. _Retry only 429/5xx/timeouts, and only POSTs that carry an Idempotency-Key._ Retrying a wrong request never helps, and retrying a write without a key could double-book.
2. _Idempotency is enforced on both sides._ The mock API replays the first answer for a repeated key; the backend derives the key from (conversation, booking, flight) so a repeat from the model produces the same key.
3. _Errors are values (`ToolResult`)._ The agent loop always gets a typed answer it can explain to the customer.

**What could go wrong.** The upstream returns 200 with a garbage body. Every response is parsed with zod; invalid bodies become `UNAVAILABLE`, never trusted data.

**Interview questions.**

- _What is jitter for?_ Stops many clients retrying at the exact same moment (thundering herd).
- _How do you stop double-booking?_ Idempotency key on the write; server stores first result by key.
- _Why compare signatures with `timingSafeEqual`?_ A normal comparison leaks how many leading bytes matched through timing.

**Read first.** `backend/src/tools/http/api-client.ts`, `mock-services/src/airline-api/index.ts`, `tests/tools/`.

---

## Phase 2 — Agent engine + SkyLink tools

**What we built.** The agent loop (`agent/loop.ts`): classify the message, retrieve policy, then call the model with the client's allowed tools for up to 6 rounds. Every tool call goes through the dispatcher (allow-list, zod validation, auth gate and rules, then run). State (verified, journey step, small collected facts) is saved per conversation and every step is written to `tool_calls` and `trace_events`. SkyLink gets five tools and `POST /chat`.

**Three decisions and why.**

1. _Rules are enforced by the dispatcher, not the prompt._ A customer cannot talk the code out of "verify first". See ADR 0001.
2. _Tools remember small flat facts in conversation state_ (booking summary, offered flights). The model gets them in the prompt next turn, and `change_flight` checks the flight id against the offered list, so the model cannot invent a flight.
3. _Route and date for the alternatives search come from the booking, not from the model._ Less model-controlled input means less to attack.

**What could go wrong in production.** The model loops on a blocked tool. The loop counter stops at 6, the customer gets an apology and a human handoff.

**Interview questions.**

- _How do you stop prompt injection from causing a bad action?_ Untrusted text only ever goes in the user role, the model can only call allow-listed tools, and every action is gated by code (verification, ownership, offered-flight check, explicit confirmation flag).
- _Why a loop limit?_ Models can ping-pong with tools forever; cost and latency grow without bound.
- _Why return errors as values to the model?_ It can explain them gracefully, and the engine can count them (two outages in a row means handoff).

**Read first.** `backend/src/agent/loop.ts`, `backend/src/tools/dispatcher/dispatcher.ts`, `clients/skylink-air/tools/change-flight.ts`, `tests/agent/loop.test.ts`.

---

## Phase 3 — Knowledge search (RAG) with citations

**What we built.** 12 SkyLink policy documents. Ingest chunks them by heading, embeds, and stores chunks with source and `updated_at` in pgvector. Retrieval takes the top 8 by cosine similarity, reranks by blending similarity with keyword overlap, and applies a relevance gate. Retrieved text goes into the prompt as `[Source: file]`, and the UI shows it under "Knowledge used".

**Three decisions and why.**

1. _A relevance gate, not just top-k._ Vector search always returns something. Without a gate the agent would answer "do you allow peacocks" from the nearest baggage text.
2. _The fallback reply is deterministic and skips the model._ For a policy question with no policy, the engine answers "I'm not sure" and offers a human. It cannot be improvised.
3. _Default embeddings are a local hashing function._ No key, deterministic tests. `EMBEDDING_PROVIDER=openai` gives real semantics. The abstraction hides the difference.

**What could go wrong.** The embedding service is down. Retrieval reports "nothing relevant", so policy questions get the safe fallback instead of a guess.

**Interview questions.**

- _Why chunk by heading?_ Each section is one self-contained rule, so citations are precise.
- _How do you know retrieval is good?_ Tests with real documents (right source for six questions, nothing for three unrelated ones) and scenarios in the eval suite.
- _Why store `updated_at` and source?_ Stale policy is a real risk; you can show and audit where an answer came from.

**Read first.** `backend/src/knowledge/retrieve.ts`, `backend/src/knowledge/chunk.ts`, `tests/knowledge/knowledge.test.ts`.

---

## Phase 4 — Human handoff + observability

**What we built.** Triggers: user asks, two failed turns, frustration, always-escalate intents, loop guard, tool unavailable twice, AI model down, and the agent's own `transfer_to_human`. A handoff stores a 3-line summary, intent, verified status and what the AI tried, then sends a signed webhook to the contact-center mock. The trace API feeds the Live Trace.

**Three decisions and why.**

1. _Triggers are pure functions_ (`handoff/triggers.ts`), so each one has a tiny test with no model involved.
2. _The database row is the queue._ The webhook can fail; the handoff is never lost, and the inbox still shows it.
3. _The summary never quotes the customer._ Free text can hold names we cannot reliably mask, so the summary is built from state. An optional LLM rewrite is masked too.

**What could go wrong.** The webhook is replayed or forged. It signs `timestamp.body` with HMAC SHA-256, compares with `timingSafeEqual`, rejects old timestamps, and the receiver ignores a repeated event id.

**Interview questions.**

- _Why sign the timestamp too?_ Otherwise a captured body could be replayed forever.
- _Why not hand off on the first error?_ Transient errors are normal; two in a row, or two failed turns, signals a real problem.
- _What is in the summary and why?_ Intent, verified status, what was tried: the human should not have to ask again.

**Read first.** `backend/src/handoff/triggers.ts`, `backend/src/handoff/webhook.ts`, `mock-services/src/contact-center/index.ts`, `tests/handoff/handoff.test.ts`.

---

## Phase 5 — UI/UX

**What we built.** Home with two client cards, the Agent Console (chat, Live Trace, Conversation State and Knowledge used; tabs on mobile), the Handoff Inbox, the Test Dashboard, a read-only Client Config viewer, a Demo controls drawer, light/dark theme, loading skeletons, empty and error states.

**Three decisions and why.**

1. _Plain-language trace labels come from the tool definitions_ ("Checked the booking system"); raw JSON sits behind "Show details".
2. _Components are presentational; logic lives in hooks_ (`useChat`, `useVoice`, `useAsync`).
3. _Accessibility is tested, not hoped for._ axe runs on every screen, and a test computes WCAG contrast ratios from the real colour tokens in four theme/accent combinations.

**What could go wrong.** The backend is down. Every screen shows an error state with a "Try again" button instead of a blank page.

**Interview questions.**

- _Why not rely on colour alone for status?_ Trace dots carry hidden text ("Succeeded", "Failed") for screen readers.
- _Why per-client accent colours via CSS variables?_ One `data-accent` attribute re-themes a page, with contrast checked per accent.
- _How do you keep the UI honest when the API is slow?_ Skeletons while loading, typing indicator while the agent works.

**Read first.** `frontend/src/pages/agent-console.tsx`, `frontend/src/hooks/use-chat.ts`, `frontend/src/__tests__/`.

---

## Phase 6 — Scenario test suite + Test Dashboard

**What we built.** YAML scenarios (persona, scripted customer turns, expected tools in order, forbidden tools, forbidden phrases, expected outcome). 20 SkyLink scenarios cover happy paths, unverified access, injection, API down, duplicate rebooking, multi-intent, angry customer, out of scope and unknown policy. The runner combines deterministic checks with an LLM judge that must write a reason. Results are stored and shown in the dashboard. `pnpm eval skylink-air` prints the score.

**Three decisions and why.**

1. _Deterministic checks first, judge second._ Tool order and rule violations never flake; the judge only covers tone and accuracy.
2. _"Forbidden" means "must not succeed"._ The model may try a blocked tool; what matters is that the rule stopped it.
3. _The mock world is reset before each run and test handoffs stay out of the real inbox._

**Scores.** First-run and improved scores against the real LLM are **not recorded: no model API key was available in the build environment**, so the suite was verified only with a scripted model (runner, checks and loader are covered by `tests/evals/`). After you run `pnpm eval skylink-air`, write the first-run score here, fix failures, and write the improved score:

- First run: _not yet run_
- After fixes: _not yet run_

**What could go wrong.** The judge is itself an LLM and can be wrong or unavailable. Judge failures count as test failures with the reason shown, so a bad judge is visible rather than silently passing.

**Interview questions.**

- _How do you evaluate an agent?_ Scenario tests with both hard assertions and an LLM judge, kept separate from fast unit tests.
- _Why scripted customer turns?_ Reproducible. The trade-off is less adaptive than a simulated user.
- _How do you avoid overfitting to the suite?_ Keep adding scenarios from real failures; never edit a scenario just to make it pass.

**Read first.** `backend/src/evals/checks.ts`, `backend/src/evals/judge.ts`, `clients/skylink-air/scenarios/`.

---

## Phase 7 — Voice mode (SkyLink)

**What we built.** Browser speech-to-text and `speechSynthesis`, a mic button, a waveform driven by the microphone level, live captions, barge-in, voice-friendly replies from the persona `voiceStyle`, numbers read naturally by `formatForSpeech`, and a "voice latency" trace line (speech end to first audio). Browsers without speech support get a clear message and text chat keeps working.

**Three decisions and why.**

1. _Voice uses the same `/chat` endpoint with `channel: 'voice'`._ Only the prompt changes (short, no markdown); the engine stays identical.
2. _Barge-in cancels speech on the first recognised word._ Recognition stays on while the agent talks.
3. _`formatForSpeech` lives in `shared/` and is unit-tested_, so "SK1001" is read as "S K 1 0 0 1".

**What could go wrong.** Speakers feed the agent's voice back into the mic. We request echo cancellation, but it depends on the browser and hardware.

**Interview questions.**

- _How is latency measured?_ From the final transcript timestamp to the utterance `onstart` event.
- _Why not a paid voice service?_ The demo needs no keys; the architecture would swap in a streaming service behind the same hook.
- _What is missing for real phone calls?_ SIP/telephony, streaming ASR and TTS, call routing, recording consent.

**Read first.** `frontend/src/hooks/use-voice.ts`, `shared/src/speech-format.ts`, `frontend/src/components/voice/voice-controls.tsx`.

---

## Phase 8 — Second client: NovaTel

**What we built.** `clients/novatel/`: config, three tools (`verify_customer`, `get_bill`, `check_outage`) plus the shared `transfer_to_human`, five policy documents and eight scenarios. Cancellations always escalate (config only). The engine was not touched: `git diff` for `backend/src/agent` and `backend/src/tools` is empty.

**Three decisions and why.**

1. _Tool registries are per client_, because both clients have a `verify_customer` with different behaviour.
2. _Outage status needs no verification_ (public information); only `get_bill` is in the verification rule.
3. _`transfer_to_human` is shared engine code_, so each client gets consistent handoff behaviour.

**What could go wrong.** A client config lists a tool that does not exist. Startup validation throws immediately with the client and tool name.

**Interview questions.**

- _How do you prove the engine is reusable?_ Add a different client and show the engine diff is empty.
- _What would force an engine change?_ A new rule kind or a new journey hook; then every client benefits.
- _How do you stop one client's tools leaking to another?_ The dispatcher only knows that client's tool list (tested).

**Read first.** `clients/novatel/`, `clients/registry.ts`, `tests/clients/novatel.test.ts`, `docs/ADDING_A_CLIENT.md`.

---

## Phase 9 — Documentation and demo polish

**What we built.** README (pitch, Mermaid diagram, 5-command setup, tests, limitations), `docs/ARCHITECTURE.md`, four ADRs, `docs/ADDING_A_CLIENT.md` and a 2-minute `docs/DEMO_SCRIPT.md`.

**Three decisions and why.**

1. _The README states what is not production-ready_ (browser voice, mock APIs, small eval set). Honest limits build more trust than polish.
2. _ADRs are short_ (context, decision, consequences) so they get read.
3. _The demo script follows the story:_ rebooking, failure handled, handoff, test dashboard, NovaTel config.

**What could go wrong.** Docs drift from code. Examples reference real files and fake customer ids that tests also use.

**Interview questions.**

- _What would you do next?_ Real authentication, monitoring, larger eval set, streaming voice.
- _What is the riskiest part?_ The LLM judge and lexical embeddings: both are replaceable behind small interfaces.
- _How would you onboard a third client?_ Follow `docs/ADDING_A_CLIENT.md`.

**Read first.** `README.md`, `docs/ARCHITECTURE.md`, `docs/decisions/`.
