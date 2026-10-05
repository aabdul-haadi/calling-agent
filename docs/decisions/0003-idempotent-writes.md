# ADR 0003: Write actions are idempotent

**Status:** accepted

**Context.** Networks time out after the server has already acted. Models repeat calls. Retrying a "change flight" naively can double-book.

**Decision.** `change_flight` derives an idempotency key from (conversation, booking, flight) and sends it as `Idempotency-Key`. The company API stores the first response per key and replays it (and rejects the same key with a different request). The backend also caches successful results by key in `idempotency_keys`. The HTTP client retries a POST only if it carries an idempotency key.

**Consequences.** Retries and repeated model calls are safe. A deliberate second change in the same conversation is stopped by a separate rule (`maxCallsPerConversation`), not by idempotency.
