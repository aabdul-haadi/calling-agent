import { eq } from 'drizzle-orm';
import type { IdempotencyStore } from '../../tools/security';
import type { Db } from '../client';
import { idempotencyKeys } from '../schema';

export function createDbIdempotencyStore(db: Db): IdempotencyStore {
  return {
    async get(key) {
      const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      return row?.result;
    },
    async set(key, result) {
      await db.insert(idempotencyKeys).values({ key, result }).onConflictDoNothing();
    },
  };
}
