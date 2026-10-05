import { createHmac, timingSafeEqual } from 'node:crypto';

// Node-only (kept out of index.ts so the browser bundle never pulls in node:crypto).
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Signs `${timestamp}.${body}` so a captured body cannot be replayed with a new timestamp. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface VerifyInput {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  now?: number;
  toleranceMs?: number;
}

export function verifySignature(input: VerifyInput): boolean {
  const { secret, timestamp, body, signature, now = Date.now() } = input;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > (input.toleranceMs ?? SIGNATURE_TOLERANCE_MS)) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
