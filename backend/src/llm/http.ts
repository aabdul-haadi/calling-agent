import { fail, ok, type ToolResult } from '@adk/shared';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus } from '../tools/http';

/** The message of a call that was cancelled on purpose (the customer interrupted). */
export const CANCELLED_MESSAGE = 'The request was cancelled';

/** Free tiers rate-limit by tokens per minute, so a 429 is worth waiting out for a while. */
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RATE_LIMIT_WAIT_MS = 25_000;

/**
 * How long the provider asks us to wait: the Retry-After header (seconds), or the
 * "try again in 8.1s" / "in 350ms" hint some providers (Groq) put in the error message.
 */
export function parseRetryAfterMs(headers: Headers, bodyText: string): number | undefined {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.round(header * 1000);
  const m = /try again in\s+(?:(\d+(?:\.\d+)?)\s*(ms|s)\b|(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s)/i.exec(
    bodyText,
  );
  if (!m) return undefined;
  if (m[1] !== undefined)
    return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'ms' ? 1 : 1000));
  return Math.round((Number(m[3] ?? 0) * 60 + Number(m[4])) * 1000);
}

/**
 * POST with retry on 429/5xx/timeouts, returning the response un-read. `signal` cancels the request
 * (and any wait between retries) at once: a cancelled call is never retried.
 */
async function send(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<ToolResult<Response>> {
  const doFetch = opts.fetchImpl ?? fetch;
  // A wait between retries ends the moment the call is cancelled.
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }));
  let rateLimited = 0;
  const cancelled = () => fail('UNAVAILABLE', CANCELLED_MESSAGE);
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) return cancelled();
    let res: Response | undefined;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 60_000)])
          : AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch {
      if (opts.signal?.aborted) return cancelled();
      res = undefined;
    }

    if (res?.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
      rateLimited += 1;
      const text = await res.text().catch(() => '');
      const asked = parseRetryAfterMs(res.headers, text);
      // +250ms of slack so we do not land a hair before the window reopens.
      await sleep(Math.min(MAX_RATE_LIMIT_WAIT_MS, (asked ?? 2000 * rateLimited) + 250));
      attempt -= 1; // rate-limit waits do not use up the normal retry budget
      continue;
    }

    const transient = !res || (isRetryableStatus(res.status) && res.status !== 429);
    if (transient && attempt < DEFAULT_RETRY.retries) {
      await sleep(backoffDelay(attempt, DEFAULT_RETRY, Math.random));
      continue;
    }
    if (!res) return fail('UNAVAILABLE', 'The AI model did not respond');
    if (!res.ok) {
      // Keep only the provider's short error message (never the whole body, which may echo
      // request content). It goes to logs and the trace "details", not to the customer.
      const raw = (await res.text().catch(() => '')).slice(0, 2000);
      let reason = '';
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
        const m = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        if (typeof m === 'string') reason = m.slice(0, 300);
      } catch {
        // not JSON: no reason to show
      }
      return fail(
        'UNAVAILABLE',
        `The AI model returned an error (${res.status})${reason ? `: ${reason}` : ''}`,
      );
    }
    return ok(res);
  }
}

type PostOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

/** POST JSON and read the JSON answer. Shared by both provider adapters. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions = {},
): Promise<ToolResult<unknown>> {
  const res = await send(url, headers, body, opts);
  if (!res.ok) return res;
  try {
    return ok(await res.data.json());
  } catch {
    return opts.signal?.aborted
      ? fail('UNAVAILABLE', CANCELLED_MESSAGE)
      : fail('UNAVAILABLE', 'The AI model returned an unreadable response');
  }
}

/** POST JSON and hand back the response so the caller can read it as a stream. */
export const postStream = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostOptions = {},
): Promise<ToolResult<Response>> => send(url, headers, body, opts);

/**
 * Server-sent events: yields the `data:` payload of each event. Handles events split across network
 * chunks. Ends when the stream ends or a `[DONE]` marker arrives.
 */
export async function* readSse(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data === '[DONE]') return;
        if (data) yield data;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
