import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '@backend/tools/security';

const secret = 'topsecret-value';
const body = JSON.stringify({ hello: 'world' });

describe('HMAC signing', () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now);
  const signature = signPayload(secret, timestamp, body);

  it('accepts a valid signature', () => {
    expect(verifySignature({ secret, timestamp, body, signature, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature({ secret, timestamp, body: body + ' ', signature, now })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifySignature({ secret: 'other-secret', timestamp, body, signature, now })).toBe(false);
  });

  it('rejects stale timestamps (replay protection)', () => {
    expect(verifySignature({ secret, timestamp, body, signature, now: now + 10 * 60_000 })).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifySignature({ secret, timestamp, body, signature: 'abcd', now })).toBe(false);
    expect(verifySignature({ secret, timestamp, body, signature: '', now })).toBe(false);
    expect(verifySignature({ secret, timestamp: 'nope', body, signature, now })).toBe(false);
  });
});
