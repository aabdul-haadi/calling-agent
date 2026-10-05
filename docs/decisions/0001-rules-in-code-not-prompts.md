# ADR 0001: Business rules live in code, not prompts

**Status:** accepted

**Context.** A system prompt saying "never change a booking before verification" is a request, not a guarantee. A customer can talk the model out of it, or the model can simply err.

**Decision.** Rules are data in the client config (`requiresVerification`, `maxCallsPerConversation`) and are enforced by the tool dispatcher before any tool runs. Ownership checks live in the tools. The prompt repeats the rules only so the model behaves politely and does not waste steps.

**Consequences.** Safety does not depend on model behaviour and is unit-testable without a model (`tests/tools/dispatcher.test.ts`, `tests/agent/loop.test.ts`). Cost: every rule needs a code path, and the model may still _try_ a blocked action, so blocked results come back as typed errors it can explain.
