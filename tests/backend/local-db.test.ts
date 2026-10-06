import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { connectDb, createLocalFileDb, runMigrations } from '@backend/database';

const root = mkdtempSync(join(tmpdir(), 'adk-pglite-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('local file database (pglite:)', () => {
  it('persists data between opens and needs no Docker', async () => {
    const dir = join(root, 'persist', 'data');
    const first = await connectDb(`pglite:${dir}`);
    await runMigrations(first);
    await first.db.execute(sql`INSERT INTO clients (id, display_name) VALUES ('x', 'X')`);
    await first.close();

    const second = await connectDb(`pglite:${dir}`);
    const res = await second.db.execute(sql`SELECT count(*)::int AS n FROM clients`);
    expect((res as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(1);
    await second.close();
  });

  it('refuses a second process while the first one holds the folder', async () => {
    const dir = join(root, 'locked', 'data');
    const first = await createLocalFileDb(dir);
    // Pretend another live process (pid 1 is not us) owns the lock.
    writeFileSync(join(root, 'locked', 'data.lock'), String(process.ppid));
    await expect(createLocalFileDb(dir)).rejects.toThrow(/already open in another process/);
    await first.close();
  });

  it('ignores a stale lock from a dead process', async () => {
    const dir = join(root, 'stale', 'data');
    const first = await createLocalFileDb(dir);
    await first.close();
    writeFileSync(join(root, 'stale', 'data.lock'), '99999999');
    const again = await createLocalFileDb(dir);
    await again.close();
  });
});
