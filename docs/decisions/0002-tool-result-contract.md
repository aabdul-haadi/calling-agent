# ADR 0002: Tools return typed results instead of throwing

**Status:** accepted

**Context.** Tools call flaky external systems. Exceptions crossing layers make it easy to crash a conversation or leak internals, and the model never sees a structured reason.

**Decision.** Every tool, the HTTP client and the LLM adapter return `ToolResult<T>`: `{ ok: true, data }` or `{ ok: false, error: 'NOT_FOUND' | 'UNAUTHORIZED' | 'AUTH_REQUIRED' | 'INVALID_ARGS' | 'UNAVAILABLE' | 'RULE_BLOCKED', message }`. The HTTP client maps statuses to these codes. The agent loop feeds the typed error to the model and uses it for counters (e.g. two `UNAVAILABLE` in a row triggers a handoff).

**Consequences.** Failure handling is uniform and testable. The error vocabulary is small on purpose; new failure kinds must map onto it.
