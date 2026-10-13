import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, postJson, waitContext } from '@backend/llm/http';
import { createOpenAiClient } from '@backend/llm';

const groq429 = JSON.stringify({
  error: {
    message:
      'Rate limit reached for model `x` on tokens per minute (TPM): Limit 8000, Used 7547, Requested 1533. Please try again in 8.1s. Need more tokens?',
  },
});

describe('parseRetryAfterMs', () => {
  it('reads the Retry-After header first', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '3' }), '')).toBe(3000);
  });
  it('reads the "try again in" hint in seconds, milliseconds and minutes', () => {
    const h = new Headers();
    expect(parseRetryAfterMs(h, 'Please try again in 8.1s.')).toBe(8100);
    expect(parseRetryAfterMs(h, 'Please try again in 350ms.')).toBe(350);
    expect(parseRetryAfterMs(h, 'Please try again in 1m30.5s.')).toBe(90_500);
    expect(parseRetryAfterMs(h, 'nothing useful')).toBeUndefined();
  });
});

describe('postJson rate limiting', () => {
  const make = (statuses: number[]) => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      const status = statuses[n++] ?? 200;
      return new Response(status === 429 ? groq429 : JSON.stringify({ ok: true }), { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, sleeps, sleep: async (ms: number) => void sleeps.push(ms), calls: () => n };
  };

  it('waits as long as the provider asks, then succeeds', async () => {
    const t = make([429, 429, 200]);
    const res = await postJson('http://x', {}, {}, { fetchImpl: t.fetchImpl, sleep: t.sleep });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(t.sleeps).toEqual([8350, 8350]);
  });

  it('tells the caller how long a call spent waiting for the rate limit, separately from the model', async () => {
    const t = make([429, 429, 200]);
    const ctx = { waitedMs: 0, hits: 0 };
    await waitContext.run(ctx, () =>
      postJson('http://x', {}, {}, { fetchImpl: t.fetchImpl, sleep: t.sleep }),
    );
    expect(ctx).toEqual({ waitedMs: 16_700, hits: 2 });
    // concurrent calls keep their own totals
    const a = { waitedMs: 0, hits: 0 };
    const b = { waitedMs: 0, hits: 0 };
    const ta = make([429, 200]);
    const tb = make([200]);
    await Promise.all([
      waitContext.run(a, () =>
        postJson('http://x', {}, {}, { fetchImpl: ta.fetchImpl, sleep: ta.sleep }),
      ),
      waitContext.run(b, () =>
        postJson('http://x', {}, {}, { fetchImpl: tb.fetchImpl, sleep: tb.sleep }),
      ),
    ]);
    expect(a.hits).toBe(1);
    expect(b.hits).toBe(0);
  });

  it('gives up after the rate-limit budget and reports the provider reason', async () => {
    const t = make([429, 429, 429, 429, 429, 429]);
    const res = await postJson('http://x', {}, {}, { fetchImpl: t.fetchImpl, sleep: t.sleep });
    expect(t.calls()).toBe(5); // 1 try + 4 waits
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/429.*Rate limit reached/);
  });

  it('caps a very long wait', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () =>
      n++ === 0
        ? new Response('{}', { status: 429, headers: { 'retry-after': '600' } })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await postJson('http://x', {}, {}, { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([25_000]);
  });

  it('sends reasoning_effort only when configured', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const req = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };
    await createOpenAiClient({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'http://x/v1',
      reasoningEffort: 'low',
      fetchImpl,
    }).complete(req);
    await createOpenAiClient({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'http://x/v1',
      fetchImpl,
    }).complete(req);
    expect(bodies[0]?.reasoning_effort).toBe('low');
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
  });
});
