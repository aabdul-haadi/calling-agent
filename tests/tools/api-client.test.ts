import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '@backend/tools/http';
import { backoffDelay, isRetryableStatus } from '@backend/tools/http';
import { createTokenCache } from '@backend/tools/auth';
import { ok } from '@adk/shared';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const schema = z.object({ value: z.number() });
const noSleep = async () => undefined;

function client(responses: (Response | Error)[], extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl, sleep: noSleep, random: () => 0.5, ...extra });
  return { api, calls, fetchImpl };
}

describe('retry rules', () => {
  it('retries only 429 and 5xx', () => {
    expect([429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([200, 400, 401, 404, 409, 422].some(isRetryableStatus)).toBe(false);
  });

  it('backs off exponentially with jitter inside [exp/2, exp]', () => {
    const policy = { retries: 3, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(0, policy, () => 0)).toBe(50);
    expect(backoffDelay(0, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(400);
    expect(backoffDelay(10, policy, () => 1)).toBe(1000); // capped
  });
});

describe('api client', () => {
  it('retries a 503 then succeeds', async () => {
    const { api, fetchImpl } = client([json(503, {}), json(200, { data: { value: 1 } })]);
    const res = await api.request({ path: '/x', schema });
    expect(res).toEqual({ ok: true, data: { value: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and returns UNAVAILABLE', async () => {
    const { api, fetchImpl } = client([json(503, {}), json(503, {}), json(503, {})]);
    const res = await api.request({ path: '/x', schema });
    expect(res).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 try + 2 retries
  });

  it('does not retry 4xx errors and maps them to typed errors', async () => {
    const notFound = client([json(404, { error: { message: 'nope' } })]);
    expect(await notFound.api.request({ path: '/x', schema })).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(notFound.fetchImpl).toHaveBeenCalledTimes(1);

    const conflict = client([json(409, { error: { message: 'full' } })]);
    expect(await conflict.api.request({ path: '/x', schema })).toMatchObject({ ok: false, error: 'RULE_BLOCKED', message: 'full' });

    const bad = client([json(400, {})]);
    expect(await bad.api.request({ path: '/x', schema })).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
  });

  it('retries timeouts and network errors', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { api, fetchImpl } = client([timeout, new TypeError('fetch failed'), json(200, { data: { value: 2 } })]);
    expect(await api.request({ path: '/x', schema })).toEqual({ ok: true, data: { value: 2 } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never retries a POST that has no idempotency key', async () => {
    const { api, fetchImpl } = client([json(503, {}), json(200, { data: { value: 1 } })]);
    const res = await api.request({ method: 'POST', path: '/x', body: {}, schema });
    expect(res).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a POST when an idempotency key makes it safe', async () => {
    const { api, fetchImpl } = client([json(503, {}), json(200, { data: { value: 1 } })]);
    const res = await api.request({
      method: 'POST', path: '/x', body: {}, headers: { 'Idempotency-Key': 'k1' }, schema,
    });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects responses that do not match the schema', async () => {
    const { api } = client([json(200, { data: { value: 'not-a-number' } })]);
    expect(await api.request({ path: '/x', schema })).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
  });

  it('refreshes the token once after a 401', async () => {
    let n = 0;
    const tokens = createTokenCache({ fetchToken: async () => ok({ token: `t${++n}`, expiresInSec: 3600 }) });
    const { api, calls } = client([json(401, {}), json(200, { data: { value: 3 } })], { tokens });
    expect(await api.request({ path: '/x', schema })).toEqual({ ok: true, data: { value: 3 } });
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('adds query params and extra headers', async () => {
    const { api, calls } = client([json(200, { data: { value: 1 } })], { extraHeaders: () => ({ 'x-sim-fail': '1' }) });
    await api.request({ path: '/flights', query: { origin: 'JFK', skip: undefined }, schema });
    expect(calls[0]?.url).toBe('http://api.test/flights?origin=JFK');
    expect((calls[0]?.init.headers as Record<string, string>)['x-sim-fail']).toBe('1');
  });
});
