import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import pg from 'pg';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../config/repo-root';
import * as schema from './schema';

/** Both Postgres and the in-process database share this type, so repositories are agnostic. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbKind = 'postgres' | 'memory';

export interface DbHandle {
  db: Db;
  kind: DbKind;
  close: () => Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function createPostgresDb(url: string, ssl = false): Promise<DbHandle> {
  // Hosted Postgres (e.g. Supabase) requires TLS. Its certificate chain is not in Node's default
  // trust store on every machine, so we encrypt without verifying the server identity.
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  // Swallow idle-client errors so a DB restart does not crash the process.
  pool.on('error', () => undefined);
  const db = drizzlePg(pool, { schema });
  return { db, kind: 'postgres', close: () => pool.end() };
}

/** In-process Postgres (WASM) with pgvector. Used by tests (in memory) and by `pglite:` local mode. */
export async function createMemoryDb(dataDir?: string): Promise<DbHandle> {
  const client = new PGlite({ dataDir, extensions: { vector } });
  const db = drizzlePglite(client, { schema });
  return { db, kind: 'memory', close: () => client.close() };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Local file-backed database (`DATABASE_URL=pglite:./.pglite/data`). PGlite allows ONE process per
 * folder and would corrupt data if two opened it, so a lock file refuses a second process.
 */
export async function createLocalFileDb(dir: string): Promise<DbHandle> {
  const dataDir = isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
  mkdirSync(dataDir, { recursive: true });
  const lockFile = resolve(dataDir, '..', `${resolve(dataDir).split(/[\\/]/).pop()}.lock`);
  try {
    const pid = Number(readFileSync(lockFile, 'utf8'));
    if (pid !== process.pid && isAlive(pid)) {
      throw new Error(
        `The local database at ${dataDir} is already open in another process (pid ${pid}). ` +
          'Stop it first (for example stop `pnpm dev` before `pnpm eval`), or use Postgres via DATABASE_URL.',
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The local database')) throw err;
  }
  writeFileSync(lockFile, String(process.pid));
  // We now own the folder. A process that was killed hard (Ctrl+C, `tsx watch` restart, crash)
  // leaves Postgres' own `postmaster.pid` behind, and PGlite aborts on startup when it sees one.
  rmSync(resolve(dataDir, 'postmaster.pid'), { force: true });
  // After an unclean exit Postgres runs crash recovery, whose checkpoint renames
  // `replorigin_checkpoint.tmp` over `replorigin_checkpoint`. Windows refuses to rename over an
  // existing file, which makes Postgres PANIC and PGlite abort. These files only hold logical
  // replication progress, which this app never uses, so removing them is safe.
  for (const f of ['replorigin_checkpoint', 'replorigin_checkpoint.tmp']) {
    rmSync(resolve(dataDir, 'pg_logical', f), { force: true });
  }
  const handle = await createMemoryDb(dataDir);
  return {
    ...handle,
    close: async () => {
      await handle.close();
      rmSync(lockFile, { force: true });
    },
  };
}

/**
 * `postgres://...` connects to Postgres (Docker, Supabase...). `pglite:<folder>` uses the
 * zero-install local database, so the app runs with no Docker and no hosted database.
 */
export async function connectDb(url: string, ssl = false): Promise<DbHandle> {
  if (url.startsWith('pglite:'))
    return createLocalFileDb(url.slice('pglite:'.length) || '.pglite/data');
  return createPostgresDb(url, ssl);
}

export async function runMigrations(handle: DbHandle, kind: DbKind = handle.kind): Promise<void> {
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
