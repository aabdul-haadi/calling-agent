import asyncio

import httpx

from app.integrations.agent_runtime import HttpAgentRuntime


def test_stream_turn_sends_idempotency_and_gateway_credentials():
    seen = {}

    async def handler(request):
        seen["key"] = request.headers.get("idempotency-key")
        seen["gateway_secret"] = request.headers.get("x-voice-gateway-secret")
        return httpx.Response(200, content=b'{"type":"turn.completed"}\n', request=request)

    async def run():
        runtime = HttpAgentRuntime(
            "http://agent",
            gateway_secret="voice-shared-secret",
            transport=httpx.MockTransport(handler),
        )
        try:
            events = [
                event
                async for event in runtime.stream_turn(
                    client_id="skylink-air",
                    conversation_id=None,
                    message="hello",
                    low_confidence=False,
                    idempotency_key="voice-logical-turn-0001",
                )
            ]
            return events
        finally:
            await runtime.aclose()

    assert asyncio.run(run()) == [{"type": "turn.completed"}]
    assert seen["key"] == "voice-logical-turn-0001"
    assert seen["gateway_secret"] == "voice-shared-secret"
