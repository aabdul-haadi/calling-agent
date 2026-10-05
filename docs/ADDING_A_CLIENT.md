# Adding a client

Goal: a new company without touching `backend/src/agent/` or `backend/src/tools/`.

**Time record:** NovaTel (config, 4 tools, 5 policy documents, 8 scenarios and its tests; the telecom mock API already existed from Phase 1) was written by the coding agent in a single short session, with no engine edits. Treat that as a lower bound: it was not timed with a stopwatch, and a human doing it for a real client will spend most of the time understanding the client's systems and policies, not on this wiring.

## Steps

1. **Create the folder** `clients/<id>/` with `client.config.ts`, `tools/`, `knowledge/`, `scenarios/` and `index.ts`.

2. **Write the config** (`client.config.ts`) as a `ClientConfig`. It is validated by `clientConfigSchema` in `shared/`. Fill in:
   - `persona` (name, tone, `voiceStyle`), `scope`, `outOfScope`
   - `intents` (the classifier may only return these, plus `unknown`)
   - `journeys` (steps for the progress bar; optional `afterUserReply` / `afterTurn` hooks)
   - `rules`: `requiresVerification` (list the tools) and `maxCallsPerConversation`
   - `tools`: the tool names this client may use
   - `escalation`: user request, max failed turns, sentiment threshold, always-escalate intents

3. **Build the tools** in `tools/` with `defineTool` from `@backend/tools/types`. Each tool has a zod `input`, a `run` that uses `ctx.api` (already bound to your API, with auth, timeouts, retry and the demo simulator), plain-language `label`/`summarize`, and `remember` to store small flattened facts. Rules for tools:
   - validate every external response with a zod schema
   - do ownership checks against `ctx.state.customerId`
   - writes must send an `Idempotency-Key` (use `buildIdempotencyKey` + `withIdempotency`)
   - return `ok(...)` / `fail(code, message)`, never throw
   - reuse the shared `transferToHuman` tool from `@backend/tools/transfer-to-human`

4. **Add the module** (`index.ts`):

   ```ts
   export const myModule: ClientModule = {
     config: clientConfigSchema.parse(myConfig),
     tools: myTools,
     apiBasePath: '/my-api', // path on MOCK_SERVICES_URL (or your real base URL)
   };
   ```

5. **Register it**: add `myModule` to `allClients` in `clients/registry.ts`. Startup validation fails loudly if a tool or rule name is wrong.

6. **Add the company system** (a mock under `mock-services/src/` while developing; the real API in production) with an OAuth token endpoint if it needs one.

7. **Write policies** as markdown in `knowledge/` (`# Title`, then `## Section` blocks). Short, one rule per section. Restart the backend (it re-ingests on start) or run `pnpm ingest <id>`.

8. **Write scenarios** in `scenarios/*.yaml` (see the SkyLink ones): scripted customer turns, `expectedTools`, `forbiddenTools`, `forbiddenPhrases`, `expectHandoff`, `expectedOutcome`. Cover at least: happy path, unverified access, injection, API down, out of scope, unknown policy.

9. **Test**: add a test like `tests/clients/novatel.test.ts` (scripted LLM), then run `pnpm eval <id>` against the real model.

## Checklist

- [ ] `git diff -- backend/src/agent backend/src/tools` is empty
- [ ] Every tool needing identity is listed in a `requiresVerification` rule
- [ ] No real brand names or data
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
