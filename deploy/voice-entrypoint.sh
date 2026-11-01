#!/bin/sh
# Start the voice engine. The speech models are fetched on first start (each file is checked
# against a pinned SHA-256 and a download that does not match is refused), then reused from the
# volume mounted on /app/voice-service/models.
set -eu

if [ -z "${VOICE_GATEWAY_SECRET:-}" ]; then
  echo "VOICE_GATEWAY_SECRET is not set; refusing to start without it." >&2
  exit 1
fi

python -m app.tools.download_models
exec python -m app.main
