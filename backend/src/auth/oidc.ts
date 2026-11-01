import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { ClientRegistry } from '../clients';
import type { Env } from '../config';
import { HttpError } from '../middleware';
import { developmentPrincipal, principalForClaims, type Principal } from './authorization';

interface DiscoveryDocument {
  issuer: string;
  jwks_uri: string;
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthenticator(env: Env, registry: ClientRegistry) {
  let discovery: Promise<{ issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  const tenants = () => registry.list().map((client) => client.config.id);

  const jwks = async () => {
    if (!discovery) {
      const current = (async () => {
        const issuer = env.OIDC_ISSUER!;
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
          response = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'The identity provider is unavailable.');
        }
        if (!response.ok)
          throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'The identity provider configuration could not be loaded.');
        const document = (await response.json()) as Partial<DiscoveryDocument>;
        if (document.issuer !== issuer || typeof document.jwks_uri !== 'string')
          throw new HttpError(503, 'AUTH_PROVIDER_INVALID', 'The identity provider configuration is invalid.');
        let jwksUrl: URL;
        try {
          jwksUrl = new URL(document.jwks_uri);
        } catch {
          throw new HttpError(503, 'AUTH_PROVIDER_INVALID', 'The identity provider configuration is invalid.');
        }
        const loopback =
          jwksUrl.hostname === 'localhost' ||
          jwksUrl.hostname === '127.0.0.1' ||
          jwksUrl.hostname === '[::1]';
        if (jwksUrl.protocol !== 'https:' && !loopback)
          throw new HttpError(503, 'AUTH_PROVIDER_INVALID', 'The identity provider keys must use HTTPS.');
        return { issuer, jwks: createRemoteJWKSet(jwksUrl) };
      })();
      discovery = current.catch((error) => {
        discovery = undefined;
        throw error;
      });
    }
    return discovery;
  };

  const oidcPrincipal = async (token: string): Promise<Principal> => {
    const metadata = await jwks();
    try {
      const { payload } = await jwtVerify(token, metadata.jwks, {
        issuer: metadata.issuer,
        audience: env.OIDC_AUDIENCE!,
        algorithms: ['RS256', 'ES256', 'PS256'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0)
        throw new HttpError(401, 'UNAUTHORIZED', 'The access token has no subject.');
      return principalForClaims(
        payload,
        env.OIDC_ROLE_CLAIM,
        env.OIDC_TENANT_CLAIM,
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof errors.JOSEError)
        throw new HttpError(401, 'UNAUTHORIZED', 'The access token is invalid or expired.');
      throw error;
    }
  };

  return async (req: Request, _res: ExpressResponse, next: NextFunction) => {
    try {
      if (env.AUTH_MODE === 'development') {
        req.principal = developmentPrincipal(tenants());
        next();
        return;
      }

      const gatewaySecret = env.VOICE_GATEWAY_SECRET;
      const gatewayCredential = req.header('x-voice-gateway-secret');
      if (
        gatewaySecret &&
        gatewaySecret !== 'replace-me-voice-secret' &&
        gatewayCredential &&
        (req.path === '/chat/stream' || req.path === '/chat') &&
        equalSecret(gatewayCredential, gatewaySecret)
      ) {
        req.principal = {
          sub: 'voice-gateway',
          roles: ['support_operator'],
          tenantIds: tenants(),
          permissions: ['support:operate'],
          service: 'voice-gateway',
        };
        next();
        return;
      }

      const authorization = req.header('authorization') ?? '';
      const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
      if (!match || match[1]!.length > 16_384)
        throw new HttpError(401, 'UNAUTHORIZED', 'A valid access token is required.');
      req.principal = await oidcPrincipal(match[1]!);
      next();
    } catch (error) {
      next(error);
    }
  };
}
