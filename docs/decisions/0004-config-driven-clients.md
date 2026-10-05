# ADR 0004: Clients are config + tools in their own folder

**Status:** accepted

**Context.** The point of the kit is delivering the next client quickly. If each client forks the engine, every fix has to be repeated.

**Decision.** A client is a folder in `clients/` with a zod-validated config (persona, scope, journeys, rules, escalation), tool definitions, policy documents and test scenarios, plus one line in `clients/registry.ts`. The engine reads only the config and the tool list. The registry validates wiring at startup (tools named in the config exist, rules reference real tools).

**Consequences.** NovaTel was added with zero changes under `backend/src/agent/` and `backend/src/tools/` (checked with `git diff`). Trade-off: behaviour that does not fit config fields (a new rule _kind_, a new journey hook) needs an engine change once, then every client benefits.
