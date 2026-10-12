import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signVoiceToken } from '@backend/voice/token';
import { createHarness, type Harness } from '../helpers/harness';

const SECRET = 'a-test-voice-secret';
let off: Harness;
let on: Harness;
beforeAll(async () => {
  off = await createHarness();
  on = await createHarness({
    env: { VOICE_GATEWAY_SECRET: SECRET, VOICE_GATEWAY_HTTP_URL: 'http://127.0.0.1:1' },
  });
});
afterAll(async () => {
  await off.close();
  await on.close();
});

describe('voice token', () => {
  it('is base64url(payload).hmac and carries tenant, expiry and a unique id', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    const a = signVoiceToken(SECRET, { cid: 'skylink-air' }, now);
    const b = signVoiceToken(SECRET, { cid: 'skylink-air' }, now);
    const [body, mac] = a.token.split('.');
    expect(mac).toBe(createHmac('sha256', SECRET).update(body!).digest('hex'));
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    expect(payload).toMatchObject({
      v: 1,
      cid: 'skylink-air',
      iat: now / 1000,
      exp: now / 1000 + 60,
    });
    expect(payload.jti).not.toBe(
      JSON.parse(Buffer.from(b.token.split('.')[0]!, 'base64url').toString()).jti,
    );
    expect(a.expiresAt).toBe('2026-11-10T10:01:00.000Z');
  });
});

describe('POST /voice/session', () => {
  it('refuses when the gateway is not configured', async () => {
    const res = await request(off.app).post('/voice/session').send({ clientId: 'skylink-air' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('VOICE_NOT_CONFIGURED');
  });

  it('issues a token for a voice tenant', async () => {
    const res = await request(on.app).post('/voice/session').send({ clientId: 'skylink-air' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ protocol: 1, url: 'ws://localhost:8765/ws' });
    const [body, mac] = (res.body.data.token as string).split('.');
    expect(mac).toBe(createHmac('sha256', SECRET).update(body!).digest('hex'));
  });

  it('refuses unknown tenants, chat-only tenants and bad bodies', async () => {
    expect((await request(on.app).post('/voice/session').send({ clientId: 'nope' })).status).toBe(
      404,
    );
    const chatOnly = await request(on.app).post('/voice/session').send({ clientId: 'novatel' });
    expect(chatOnly.status).toBe(400);
    expect(chatOnly.body.error.code).toBe('CHANNEL_NOT_SUPPORTED');
    expect((await request(on.app).post('/voice/session').send({})).status).toBe(400);
    expect(
      (
        await request(on.app)
          .post('/voice/session')
          .send({ clientId: 'skylink-air', conversationId: 'x' })
      ).status,
    ).toBe(400);
  });
});

describe('GET /voice/status', () => {
  it('says unavailable, without failing, when the gateway is off or not configured', async () => {
    expect((await request(off.app).get('/voice/status')).body.data).toMatchObject({
      configured: false,
      available: false,
    });
    expect((await request(on.app).get('/voice/status')).body.data).toMatchObject({
      configured: true,
      available: false,
    });
  });
});
