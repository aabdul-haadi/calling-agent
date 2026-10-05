import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createMemoryDb, runMigrations, type DbHandle } from '@backend/database';
import { createApp } from '@backend/app';
import { loadEnv } from '@backend/config';
import { createLogger } from '@backend/logger';

let handle: DbHandle;

beforeAll(async () => {
  handle = await createMemoryDb();
  await runMigrations(handle, 'memory');
});
afterAll(() => handle.close());

const env = loadEnv({ MOCK_CLIENT_ID: 'a', MOCK_CLIENT_SECRET: 'b', WEBHOOK_SECRET: 'long-enough-secret' });

describe('foundation', () => {
  it('rejects an invalid environment with a readable message', () => {
    expect(() => loadEnv({})).toThrow(/MOCK_CLIENT_SECRET/);
  });

  it('GET /health reports the database as up', async () => {
    const app = createApp({ env, logger: createLogger('silent'), db: handle.db });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', db: 'up' } });
  });

  it('migrations created the pgvector-backed knowledge table', async () => {
    const res = await handle.db.execute(sql`SELECT count(*)::int AS n FROM knowledge_chunks`);
    expect((res as unknown as { rows: unknown[] }).rows[0]).toEqual({ n: 0 });
  });

  it('returns a typed 404 for unknown routes', async () => {
    const app = createApp({ env, logger: createLogger('silent'), db: handle.db });
    const res = await request(app).get('/nope');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
