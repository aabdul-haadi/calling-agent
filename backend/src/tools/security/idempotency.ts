import { createHash } from 'node:crypto';
import type { ToolResult } from '@adk/shared';

/**
 * Same inputs -> same key. If the model (or a network retry) repeats a write, the key is identical,
 * so the downstream API replays the first answer instead of performing the change twice.
 */
export function buildIdempotencyKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

export interface IdempotencyStore {
  get(key: string): Promise<unknown | undefined>;
  /** Must not overwrite an existing key. */
  set(key: string, result: unknown): Promise<void>;
}

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, result) => {
      if (!map.has(key)) map.set(key, result);
    },
  };
}

/** Runs a write once per key. Only successes are cached, so failed attempts can be retried. */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  run: () => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  const cached = await store.get(key);
  if (cached !== undefined) return cached as ToolResult<T>;
  const result = await run();
  if (result.ok) await store.set(key, result);
  return result;
}
