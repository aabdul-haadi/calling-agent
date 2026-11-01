"""The only way this service talks to the business logic: the TypeScript agent runtime.

The gateway sends what the customer said and receives events. It never calls company APIs, never
decides whether something is allowed, and holds no customer data beyond the conversation id. A
cancelled request (the customer interrupted) is simply a closed connection: the runtime stops at
its next safe point and keeps whatever already happened.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Protocol

import httpx


class AgentRuntime(Protocol):
    def stream_turn(
        self,
        *,
        client_id: str,
        conversation_id: str | None,
        message: str,
        low_confidence: bool,
        idempotency_key: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield the runtime's events for one turn, parsed. Cancelling the consumer cancels the turn."""


class HttpAgentRuntime:
    def __init__(
        self,
        base_url: str,
        timeout_s: float = 60.0,
        gateway_secret: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._gateway_secret = gateway_secret
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=3.0, read=timeout_s, write=5.0, pool=3.0),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def ping(self) -> bool:
        try:
            r = await self._client.get(f"{self._base}/health", timeout=2.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def stream_turn(
        self,
        *,
        client_id: str,
        conversation_id: str | None,
        message: str,
        low_confidence: bool,
        idempotency_key: str,
    ) -> AsyncIterator[dict[str, Any]]:
        body: dict[str, Any] = {"clientId": client_id, "message": message, "channel": "voice"}
        if conversation_id:
            body["conversationId"] = conversation_id
        if low_confidence:
            body["voice"] = {"lowConfidence": True}
        try:
            headers = {"Idempotency-Key": idempotency_key}
            if self._gateway_secret:
                headers["X-Voice-Gateway-Secret"] = self._gateway_secret
            async with self._client.stream(
                "POST",
                f"{self._base}/chat/stream",
                json=body,
                headers=headers,
            ) as resp:
                if resp.status_code != 200:
                    yield {
                        "type": "turn.error",
                        "code": "RUNTIME_HTTP_" + str(resp.status_code),
                        "message": "The agent could not take this turn",
                    }
                    return
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # ignore a damaged line rather than dropping the whole turn
                    if isinstance(event, dict) and isinstance(event.get("type"), str):
                        yield event
        except httpx.HTTPError:
            yield {
                "type": "turn.error",
                "code": "RUNTIME_UNREACHABLE",
                "message": "The agent is not reachable",
            }
