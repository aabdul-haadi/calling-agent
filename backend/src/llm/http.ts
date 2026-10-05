import { fail, ok, type ToolResult } from '@adk/shared';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus } from '../tools/http';

/** POST JSON with retry on 429/5xx/timeouts. Shared by both provider adapters. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ToolResult<unknown>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
    const transient = !res || isRetryableStatus(res.status);
    if (transient && attempt < DEFAULT_RETRY.retries) {
      await sleep(backoffDelay(attempt, DEFAULT_RETRY, Math.random));
      continue;
    }
    if (!res) return fail('UNAVAILABLE', 'The AI model did not respond');
    if (!res.ok) {
      // Never echo the provider body: it may contain request details.
      return fail('UNAVAILABLE', `The AI model returned an error (${res.status})`);
    }
    try {
      return ok(await res.json());
    } catch {
      return fail('UNAVAILABLE', 'The AI model returned an unreadable response');
    }
  }
}
