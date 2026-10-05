import type { ZodType } from 'zod';
import { z } from 'zod';
import { fail, ok, type ToolErrorCode, type ToolResult } from '@adk/shared';
import type { TokenCache } from '../auth';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus, type RetryPolicy } from './retry';

export interface ApiClientOptions {
  baseUrl: string;
  tokens?: TokenCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Per-request extra headers (used to forward the demo simulator controls). */
  extraHeaders?: () => Record<string, string>;
}

export interface ApiRequest<T> {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Validates the `data` field of the `{ data }` envelope. External responses are never trusted. */
  schema: ZodType<T>;
}

export interface ApiClient {
  request<T>(req: ApiRequest<T>): Promise<ToolResult<T>>;
}

const errorBody = z.object({ error: z.object({ message: z.string().optional() }).optional() });

function mapStatus(status: number): ToolErrorCode {
  if (status === 404) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 409) return 'RULE_BLOCKED';
  if (status === 429 || status >= 500) return 'UNAVAILABLE';
  return 'INVALID_ARGS';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const policy = opts.retry ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 5000;

  async function attemptOnce(url: string, init: RequestInit): Promise<Response | 'TIMEOUT' | 'NETWORK'> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'TIMEOUT'
        : 'NETWORK';
    }
  }

  return {
    async request<T>(req: ApiRequest<T>): Promise<ToolResult<T>> {
      const method = req.method ?? 'GET';
      const url = new URL(req.path, opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

      // Repeating a POST is only safe when the server can de-duplicate it.
      const headersLower = Object.keys(req.headers ?? {}).map((h) => h.toLowerCase());
      const canRetry = method === 'GET' || headersLower.includes('idempotency-key');

      let refreshedToken = false;
      for (let attempt = 0; ; attempt++) {
        const headers: Record<string, string> = {
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.extraHeaders?.(),
          ...req.headers,
        };
        if (opts.tokens) {
          const token = await opts.tokens.get();
          if (!token.ok) return token;
          headers.authorization = `Bearer ${token.data}`;
        }

        const res = await attemptOnce(url.toString(), {
          method,
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });

        // 401 usually means our cached token expired early: refresh once, not counted as a retry.
        if (typeof res !== 'string' && res.status === 401 && opts.tokens && !refreshedToken) {
          refreshedToken = true;
          opts.tokens.invalidate();
          attempt -= 1;
          continue;
        }

        const transient = typeof res === 'string' || isRetryableStatus(res.status);
        if (transient && canRetry && attempt < policy.retries) {
          await sleep(backoffDelay(attempt, policy, random));
          continue;
        }
        if (typeof res === 'string') return fail('UNAVAILABLE', 'The company system did not respond in time');

        if (!res.ok) {
          const parsed = errorBody.safeParse(await res.json().catch(() => ({})));
          const code = mapStatus(res.status);
          const serverMessage = parsed.success ? parsed.data.error?.message : undefined;
          return fail(code, code === 'UNAVAILABLE' ? 'The company system is unavailable' : (serverMessage ?? 'Request rejected'));
        }

        const json: unknown = await res.json().catch(() => undefined);
        const envelope = z.object({ data: req.schema }).safeParse(json);
        if (!envelope.success) return fail('UNAVAILABLE', 'The company system returned an unexpected response');
        return ok(envelope.data.data);
      }
    },
  };
}
