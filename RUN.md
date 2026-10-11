# RUN.md: every command to run the project

All commands run from the repo root (`agent-delivery-kit/`). Needs **Node 20+** and **pnpm 9**. Docker is optional.

## 1. First-time setup

```bash
pnpm install                  # installs all workspaces (frontend, backend, mock-services, shared)
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Then edit `.env` (see section 2 for the three choices you must make: database, AI model, secrets).

## 2. Configure `.env`

### Database: pick ONE

```bash
# A) No Docker, no install (easiest). Data is saved in .pglite/data
DATABASE_URL=pglite:.pglite/data
DATABASE_SSL=false

# B) Docker Postgres (default in .env.example)
DATABASE_URL=postgres://adk:adk@localhost:5432/adk
DATABASE_SSL=false

# C) Hosted Postgres, e.g. Supabase (use the Postgres connection string, not the API keys)
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres
DATABASE_SSL=true
```

For option B start the database first:

```bash
docker compose up -d          # Postgres 16 + pgvector
docker compose down           # stop it later
```

### AI model: pick ONE

```bash
# A) Anthropic
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=your-key

# B) Free tier: Groq (OpenAI-compatible)
LLM_PROVIDER=openai
LLM_MODEL=openai/gpt-oss-120b
LLM_REASONING_EFFORT=low
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=your-groq-key

# C) Local, no key: Ollama
LLM_PROVIDER=openai
LLM_MODEL=llama3.1
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
```

Without any working model the chat still starts and safely hands the customer to a human.

### Secrets and the rest

Change `MOCK_CLIENT_SECRET` and `WEBHOOK_SECRET` from `replace-me-...` to any random strings. Keep `EMBEDDING_PROVIDER=local` (needs no key). Never commit `.env`.

## 3. Run the whole app

```bash
pnpm db:migrate               # optional: the backend also migrates on start
pnpm dev                      # starts all three parts below at once
```

| Part                  | URL                   | Check                                      |
| --------------------- | --------------------- | ------------------------------------------ |
| Frontend (UI)         | http://localhost:5173 | open in Chrome or Edge                     |
| Backend API           | http://localhost:4000 | http://localhost:4000/health               |
| Mock company systems  | http://localhost:4100 | http://localhost:4100/health               |

Try these customers (all fake):

- **SkyLink Air:** booking `SK1001`, last name `Rahman` (flight cancelled, alternatives available). Say "My flight was cancelled", give the details, pick a flight, then approve.
- **NovaTel:** account `NT2002`, last name `Alvarez` (bill is higher because of roaming).
- More fake customers: `mock-services/src/seed-data/`.

### Run the parts separately (three terminals)

```bash
pnpm --filter @adk/mock-services dev      # mock company systems, :4100
pnpm --filter @adk/backend dev            # backend API, :4000 (restarts on change)
pnpm --filter @adk/frontend dev           # UI, :5173
```

### Production-style run

```bash
pnpm build                                # type-checks and builds the frontend into frontend/dist
pnpm --filter @adk/mock-services start    # :4100
pnpm --filter @adk/backend start          # :4000
pnpm --filter @adk/frontend exec vite preview --port 5173
```

## 4. Knowledge (policy documents)

```bash
pnpm ingest                               # re-index every client's policy documents
```

The backend also re-indexes them every time it starts.

## 5. Tests and quality checks

```bash
pnpm test                                 # 152 backend/integration + 84 frontend tests (no real model, no Docker)
pnpm lint                                 # ESLint
pnpm typecheck                            # TypeScript for every workspace
pnpm format                               # Prettier (rewrites files)
```

Run a single test file:

```bash
npx vitest run tests/agent/approval.test.ts
pnpm --filter @adk/frontend test          # frontend tests only
```

## 6. Scenario evaluations (uses the real AI model)

```bash
pnpm eval skylink-air                     # 20 scenarios, prints PASS/FAIL per scenario and SCORE
pnpm eval novatel                         # 8 scenarios
```

Or press "Run tests" on the **Evaluations** page in the UI.

Rules for evals:

- The mock services must be running (`pnpm --filter @adk/mock-services dev`).
- With `DATABASE_URL=pglite:...` only **one process** may open the database. **Stop `pnpm dev` before `pnpm eval`**, then start only the mock services.
- Free model tiers have daily token limits. If many scenarios fail with "The AI model did not respond", wait for the limit to reset.

## 7. Database commands

```bash
pnpm db:generate                          # create a new migration after editing backend/src/database/schema.ts
pnpm db:migrate                           # apply migrations
```

Reset a local database completely (deletes all conversations, traces and runs):

```bash
# stop pnpm dev first, then delete the folder
rm -rf .pglite                            # PowerShell: Remove-Item -Recurse -Force .pglite
```

## 8. Reset the demo world

The mock airline and telecom data changes as you rebook flights. Put it back to its starting state:

```bash
curl -X POST http://localhost:4100/admin/reset
```

PowerShell: `Invoke-RestMethod -Method Post http://localhost:4100/admin/reset`

## 9. Stop everything

Press `Ctrl+C` in the terminal running `pnpm dev` (the local database closes cleanly).

If processes were left behind (Windows PowerShell):

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|cmd' -and $_.CommandLine -match 'agent-delivery-kit' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 10. Quick fixes

| Problem                                                    | Fix                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| UI says "Can't reach the server"                           | Backend is not running: `pnpm dev`, then check http://localhost:4000/health                       |
| `already open in another process` (pglite)                 | Another `pnpm dev` or `pnpm eval` has the database: stop it first                                 |
| Chat answers with "I'm passing you to a human colleague"   | The AI model is unreachable or rate limited: check the key, base URL and daily limit in `.env`    |
| Port already in use                                        | Change `BACKEND_PORT` / `MOCK_PORT` in `.env` (and `VITE_API_URL`, `MOCK_SERVICES_URL` to match)  |
| Evaluations page shows an old run as stopped               | Normal: a run killed mid-way is marked stopped when the backend restarts                          |
| Voice does not work                                        | Use Chrome or Edge and allow the microphone; voice is browser speech, not a phone line            |
| 3D agent shows a flat picture                              | WebGL unavailable or "reduce motion" is on: the fallback is intentional                           |

More detail: `README.md`, `docs/ARCHITECTURE.md`, `docs/ADDING_A_CLIENT.md`, `docs/DEMO_SCRIPT.md`.
