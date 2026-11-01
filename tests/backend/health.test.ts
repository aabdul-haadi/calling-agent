import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { loadEnv } from '@backend/config';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('foundation', () => {
  it('rejects an invalid environment with a readable message', () => {
    expect(() => loadEnv({})).toThrow(/MOCK_CLIENT_SECRET/);
  });

  it('refuses production startup without OIDC configuration', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        MOCK_CLIENT_ID: 'test-client',
        MOCK_CLIENT_SECRET: 'test-secret',
        WEBHOOK_SECRET: 'test-webhook-secret',
      }),
    ).toThrow(/AUTH_MODE=oidc/);
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'http://identity.example.test',
        OIDC_AUDIENCE: 'agent-delivery-api',
        MOCK_CLIENT_ID: 'test-client',
        MOCK_CLIENT_SECRET: 'test-secret',
        WEBHOOK_SECRET: 'test-webhook-secret',
      }),
    ).toThrow(/must use HTTPS/);
  });

  it('GET /health reports the database as up', async () => {
    const res = await request(h.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', db: 'up' } });
  });

  it('migrations created the pgvector-backed knowledge table', async () => {
    const res = await h.db.db.execute(sql`SELECT count(*)::int AS n FROM knowledge_chunks`);
    expect((res as unknown as { rows: unknown[] }).rows[0]).toEqual({ n: 0 });
  });

  it('returns a typed 404 for unknown routes', async () => {
    const res = await request(h.app).get('/nope');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
