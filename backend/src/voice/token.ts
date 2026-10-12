import { createHmac, randomUUID } from 'node:crypto';

/**
 * Short-lived token that lets one browser open one voice session with the Python voice gateway.
 * The backend decides who may start a session; the gateway only checks this signature.
 *
 *   token = base64url(JSON payload) + "." + hex(HMAC-SHA256(secret, base64url(JSON payload)))
 */
export const VOICE_TOKEN_TTL_MS = 60_000;

export interface VoiceTokenClaims {
  /** Tenant the session is for. */
  cid: string;
  /** Existing conversation to continue, if any. */
  conv?: string;
}

export function signVoiceToken(
  secret: string,
  claims: VoiceTokenClaims,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor((now + VOICE_TOKEN_TTL_MS) / 1000);
  const payload = {
    v: 1,
    cid: claims.cid,
    ...(claims.conv ? { conv: claims.conv } : {}),
    iat: Math.floor(now / 1000),
    exp,
    jti: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return { token: `${body}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}
