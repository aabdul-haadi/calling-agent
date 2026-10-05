import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import pg from 'pg';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

/** Both Postgres and the in-process test database share this type, so repositories are agnostic. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function createPostgresDb(url: string): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Swallow idle-client errors so a DB restart does not crash the process.
  pool.on('error', () => undefined);
  const db = drizzlePg(pool, { schema });
  return { db, close: () => pool.end() };
}

/** In-process Postgres (WASM) with pgvector. Used by tests so they need no Docker. */
export async function createMemoryDb(): Promise<DbHandle> {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzlePglite(client, { schema });
  return { db, close: () => client.close() };
}

export async function runMigrations(handle: DbHandle, kind: 'postgres' | 'memory'): Promise<void> {
  // The extension is created outside the generated migrations because drizzle-kit cannot emit it.
  await handle.db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  if (kind === 'memory') {
    await migratePglite(handle.db as ReturnType<typeof drizzlePglite<typeof schema>>, {
      migrationsFolder,
    });
  } else {
    await migratePg(handle.db as ReturnType<typeof drizzlePg<typeof schema>>, { migrationsFolder });
  }
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
