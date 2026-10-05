import { describe, expect, it } from 'vitest';
import { createTokenCache } from '@backend/tools/auth';
import { fail, ok } from '@adk/shared';

describe('token cache', () => {
  it('reuses a valid token and refreshes before expiry', async () => {
    let now = 0;
    let fetches = 0;
    const cache = createTokenCache({
      now: () => now,
      skewMs: 1000,
      fetchToken: async () => ok({ token: `t${++fetches}`, expiresInSec: 10 }),
    });
    expect(await cache.get()).toEqual(ok('t1'));
    now = 5000;
    expect(await cache.get()).toEqual(ok('t1'));
    now = 9500; // inside the 1s skew window
    expect(await cache.get()).toEqual(ok('t2'));
  });

  it('shares one fetch between concurrent callers', async () => {
    let fetches = 0;
    const cache = createTokenCache({
      fetchToken: async () => {
        fetches++;
        await new Promise((r) => setTimeout(r, 10));
        return ok({ token: 't', expiresInSec: 60 });
      },
    });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(fetches).toBe(1);
  });

  it('does not cache failures and can be invalidated', async () => {
    let calls = 0;
    const cache = createTokenCache({
      fetchToken: async () => (++calls === 1 ? fail('UNAVAILABLE', 'down') : ok({ token: `t${calls}`, expiresInSec: 60 })),
    });
    expect((await cache.get()).ok).toBe(false);
    expect(await cache.get()).toEqual(ok('t2'));
    cache.invalidate();
    expect(await cache.get()).toEqual(ok('t3'));
  });
});
