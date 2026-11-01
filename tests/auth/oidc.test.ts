import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

let idp: Server;
let harness: Harness;
let issuer: string;
let privateKey: KeyObject;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey;
  publicJwk = {
    ...(keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };

  idp = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  const address = idp.address();
  if (!address || typeof address === 'string') throw new Error('Identity test server did not start.');
  issuer = `http://127.0.0.1:${address.port}`;

  harness = await createHarness({
    env: {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: 'adk-api',
      VOICE_GATEWAY_SECRET: 'voice-gateway-test-secret',
    },
  });
});

afterAll(async () => {
  await harness.close();
  await new Promise<void>((resolve, reject) =>
    idp.close((error) => (error ? reject(error) : resolve())),
  );
});

async function token(role: string, tenantIds: string[]): Promise<string> {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
    roles: [role],
    tenant_ids: tenantIds,
    name: 'Test User',
    email: 'operator@example.test',
      iss: issuer,
      aud: 'adk-api',
      sub: 'operator-1',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

describe('OIDC protected API', () => {
  it('keeps health and authentication configuration available without a token', async () => {
    expect((await request(harness.app).get('/health')).status).toBe(200);
    const config = await request(harness.app).get('/auth/config');
    expect(config.body.data).toEqual({ mode: 'oidc', issuer });
    expect((await request(harness.app).get('/clients')).status).toBe(401);
  });

  it('rejects invalid and expired bearer tokens', async () => {
    const invalid = await request(harness.app).get('/clients').set('Authorization', 'Bearer invalid');
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('UNAUTHORIZED');
  });

  it('filters tenant listings and profile claims to the signed-in operator', async () => {
    const accessToken = await token('support_operator', ['skylink-air']);
    const clients = await request(harness.app)
      .get('/clients')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(clients.status).toBe(200);
    expect(clients.body.data.map((client: { id: string }) => client.id)).toEqual(['skylink-air']);

    const profile = await request(harness.app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(profile.body.data).toMatchObject({
      subject: 'operator-1',
      roles: ['support_operator'],
      tenantIds: ['skylink-air'],
      authentication: 'oidc',
    });
  });

  it('blocks cross-tenant access and role-protected operations server-side', async () => {
    const supportToken = await token('support_operator', ['skylink-air']);
    const crossTenant = await request(harness.app)
      .get('/clients/novatel')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(crossTenant.status).toBe(404);

    const knowledgeToken = await token('knowledge_manager', ['skylink-air']);
    const handoffAction = await request(harness.app)
      .post('/handoffs/not-a-real-handoff/accept')
      .set('Authorization', `Bearer ${knowledgeToken}`);
    expect(handoffAction.status).toBe(403);
    expect(handoffAction.body.error.code).toBe('FORBIDDEN');
  });

  it('requires an allowed tenant for a customer-support turn', async () => {
    const supportToken = await token('support_operator', ['skylink-air']);
    const result = await request(harness.app)
      .post('/chat')
      .set('Authorization', `Bearer ${supportToken}`)
      .set('Idempotency-Key', 'oidc-cross-tenant-turn')
      .send({ clientId: 'novatel', message: 'Hello' });
    expect(result.status).toBe(404);
  });

  it('limits the voice-gateway credential to chat endpoints', async () => {
    const profile = await request(harness.app)
      .get('/clients')
      .set('X-Voice-Gateway-Secret', 'voice-gateway-test-secret');
    expect(profile.status).toBe(401);

    const turn = await request(harness.app)
      .post('/chat')
      .set('X-Voice-Gateway-Secret', 'voice-gateway-test-secret')
      .set('Idempotency-Key', 'voice-gateway-test-turn')
      .send({ clientId: 'skylink-air', channel: 'voice', message: 'Hello' });
    expect(turn.status).toBe(200);
  });
});
