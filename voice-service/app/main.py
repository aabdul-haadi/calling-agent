"""Entry point.   python -m app.main    (or: uvicorn app.main:create_app --factory)"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app.api import health, websocket
from app.config import Settings, load_settings
from app.sessions.manager import Engine


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    settings = settings or load_settings()
    engine = engine or Engine(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Load models in the background: /health answers "loading" right away instead of the
        # process looking dead for several seconds.
        loader = asyncio.create_task(engine.load_models_async())
        try:
            yield
        finally:
            loader.cancel()
            await engine.aclose()

    app = FastAPI(title="ADK voice gateway", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.engine = engine
    app.include_router(health.router)
    app.include_router(websocket.router)
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = load_settings()
    if not s.gateway_secret:
        logging.getLogger("voice").warning(
            "VOICE_GATEWAY_SECRET is not set: no session can be authorised until it is."
        )
    uvicorn.run(
        create_app(s),
        host=s.host,
        port=s.port,
        # Anything bigger than a frame plus its header is refused by the server itself.
        ws_max_size=s.max_frame_bytes + 64,
        log_level="info",
    )


if __name__ == "__main__":
    main()
