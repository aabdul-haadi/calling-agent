import time

import pytest

from app.auth import AuthError, TokenVerifier, sign

SECRET = "unit-test-secret"


def payload(**over):
    now = time.time()
    base = {"v": 1, "cid": "skylink-air", "iat": now, "exp": now + 60, "jti": "abc123"}
    base.update(over)
    return base


def test_valid_token_yields_its_claims():
    claims = TokenVerifier(SECRET).verify(
        sign(SECRET, payload(conv="11111111-1111-1111-1111-111111111111"))
    )
    assert claims.client_id == "skylink-air"
    assert claims.conversation_id == "11111111-1111-1111-1111-111111111111"


def test_a_token_works_once_only():
    v = TokenVerifier(SECRET)
    token = sign(SECRET, payload())
    v.verify(token)
    with pytest.raises(AuthError, match="already used"):
        v.verify(token)


@pytest.mark.parametrize("token", ["", "nodot", "a.b", "x" * 40 + "." + "0" * 64])
def test_garbage_is_rejected(token):
    with pytest.raises(AuthError):
        TokenVerifier(SECRET).verify(token)


def test_wrong_secret_expired_stale_and_tampered_tokens_are_rejected():
    with pytest.raises(AuthError, match="signature"):
        TokenVerifier(SECRET).verify(sign("other-secret", payload()))
    with pytest.raises(AuthError, match="expired"):
        TokenVerifier(SECRET).verify(sign(SECRET, payload(exp=time.time() - 1)))
    with pytest.raises(AuthError, match="fresh"):
        TokenVerifier(SECRET, max_age_s=10).verify(
            sign(SECRET, payload(iat=time.time() - 60, exp=time.time() + 600))
        )
    # A valid signature belongs to one body only: swapping the body must fail.
    _, mac = sign(SECRET, payload(jti="t1")).split(".")
    forged_body = sign(SECRET, payload(cid="novatel", jti="t2")).split(".")[0]
    with pytest.raises(AuthError, match="signature"):
        TokenVerifier(SECRET).verify(f"{forged_body}.{mac}")


def test_no_secret_means_no_sessions():
    with pytest.raises(AuthError, match="SECRET"):
        TokenVerifier("").verify(sign(SECRET, payload()))
