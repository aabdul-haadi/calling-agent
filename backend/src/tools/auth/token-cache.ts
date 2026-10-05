import { z } from 'zod';
import { fail, ok, type ToolResult } from '@adk/shared';

export interface TokenCache {
  get(): Promise<ToolResult<string>>;
  /** Call after a 401 so the next get() fetches a fresh token. */
  invalidate(): void;
}

export interface FetchedToken {
  token: string;
  expiresInSec: number;
}

export interface TokenCacheOptions {
  fetchToken: () => Promise<ToolResult<FetchedToken>>;
  now?: () => number;
  /** Refresh this long before real expiry so a token never dies mid-request. */
  skewMs?: number;
}

export function createTokenCache(opts: TokenCacheOptions): TokenCache {
  const now = opts.now ?? Date.now;
  const skewMs = opts.skewMs ?? 30_000;
  let cached: { token: string; expiresAt: number } | undefined;
  // Share one in-flight refresh so concurrent tool calls do not stampede the auth server.
  let inFlight: Promise<ToolResult<string>> | undefined;

  return {
    async get() {
      if (cached && cached.expiresAt - skewMs > now()) return ok(cached.token);
      inFlight ??= opts
        .fetchToken()
        .then((res): ToolResult<string> => {
          if (!res.ok) return res;
          cached = { token: res.data.token, expiresAt: now() + res.data.expiresInSec * 1000 };
          return ok(res.data.token);
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });

export interface ClientCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** OAuth2 client-credentials grant. The secret only ever travels in this one request body. */
export function clientCredentialsFetcher(creds: ClientCredentials) {
  const doFetch = creds.fetchImpl ?? fetch;
  return async (): Promise<ToolResult<FetchedToken>> => {
    try {
      const res = await doFetch(creds.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
        signal: AbortSignal.timeout(creds.timeoutMs ?? 5000),
      });
      if (res.status === 401)
        return fail('UNAUTHORIZED', 'The company system rejected our credentials');
      if (!res.ok) return fail('UNAVAILABLE', 'The company system could not issue a token');
      const parsed = tokenResponse.safeParse(await res.json());
      if (!parsed.success) return fail('UNAVAILABLE', 'Unexpected token response');
      return ok({ token: parsed.data.access_token, expiresInSec: parsed.data.expires_in });
    } catch {
      return fail('UNAVAILABLE', 'Could not reach the company system');
    }
  };
}
