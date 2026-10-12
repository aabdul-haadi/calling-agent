"""Short-lived session tokens signed by the TypeScript backend.

The browser asks the backend (POST /voice/session) for a token, then presents it to this service in
its first WebSocket message. The backend decides who may start a voice session and for which
tenant; this service only checks the signature, the age and that a token is used once.

    token = base64url(JSON payload) + "." + hex(HMAC-SHA256(secret, base64url(JSON payload)))
    payload = {"v": 1, "cid": "<tenant>", "conv": "<conversation id>"?, "iat": <s>, "exp": <s>, "jti": "<id>"}
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections import OrderedDict
from dataclasses import dataclass


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class TokenClaims:
    client_id: str
    conversation_id: str | None
    jti: str
    expires_at: float


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(secret: str, payload: dict) -> str:
    """Used by tests and tools; the production signer is the TypeScript backend."""
    body = (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .rstrip(b"=")
        .decode()
    )
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


class TokenVerifier:
    def __init__(self, secret: str, max_age_s: float = 90, remember: int = 4096) -> None:
        self._secret = secret
        self._max_age = max_age_s
        self._used: OrderedDict[str, float] = OrderedDict()
        self._remember = remember

    def verify(self, token: str, now: float | None = None) -> TokenClaims:
        if not self._secret:
            raise AuthError("voice gateway has no VOICE_GATEWAY_SECRET configured")
        now = time.time() if now is None else now
        body, sep, mac = token.partition(".")
        if not sep or not body or not mac:
            raise AuthError("malformed token")
        expected = hmac.new(self._secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, mac):
            raise AuthError("bad signature")
        try:
            p = json.loads(_b64d(body))
            if p.get("v") != 1:
                raise AuthError("unsupported token version")
            cid, jti = str(p["cid"]), str(p["jti"])
            iat, exp = float(p["iat"]), float(p["exp"])
            conv = p.get("conv")
        except AuthError:
            raise
        except Exception as exc:  # noqa: BLE001 - any parse problem is simply "invalid"
            raise AuthError("invalid token payload") from exc
        if exp <= now:
            raise AuthError("token expired")
        if now - iat > self._max_age or iat - now > 30:
            raise AuthError("token is not fresh")
        if jti in self._used:
            raise AuthError("token already used")
        self._used[jti] = exp
        while len(self._used) > self._remember:
            self._used.popitem(last=False)
        return TokenClaims(cid, str(conv) if conv else None, jti, exp)
