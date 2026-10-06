import { fail, ok, type ToolResult } from '@adk/shared';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus } from '../tools/http';

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

/** POST JSON with retry on 429/5xx/timeouts. Shared by both provider adapters. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ToolResult<unknown>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let rateLimited = 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch {
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
    try {
      return ok(await res.json());
    } catch {
      return fail('UNAVAILABLE', 'The AI model returned an unreadable response');
    }
  }
}
