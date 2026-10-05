import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';

export interface MockOptions {
  /** 0-1: fraction of API calls that randomly fail with 503. */
  failureRate: number;
  /** Base latency (ms) added to every API call. */
  latencyMs: number;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  tokenTtlSec: number;
  random: () => number;
}

export const sendError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Injects realistic misbehaviour: latency and 503s. The backend's demo controls drive the
 * x-sim-* headers; MOCK_FAILURE_RATE / MOCK_LATENCY_MS drive the background noise.
 */
export const simulate = (opts: MockOptions): RequestHandler => async (req, res, next) => {
  const headerLatency = Number(req.header('x-sim-latency-ms') ?? 0);
  const delay = opts.latencyMs + (Number.isFinite(headerLatency) ? Math.min(headerLatency, 10_000) : 0);
  if (delay > 0) await sleep(delay);
  const forced = req.header('x-sim-fail') === '1';
  if (forced || opts.random() < opts.failureRate) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Upstream system temporarily unavailable');
  }
  next();
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** OAuth2 client-credentials: POST /oauth/token -> bearer token; `requireToken` guards the API. */
export function createAuth(opts: MockOptions) {
  const tokens = new Map<string, number>();

  const tokenRouter = Router();
  tokenRouter.post('/oauth/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.grant_type !== 'client_credentials') {
      return sendError(res, 400, 'UNSUPPORTED_GRANT_TYPE', 'Use client_credentials');
    }
    if (
      !body.client_id ||
      !body.client_secret ||
      !safeEqual(body.client_id, opts.clientId) ||
      !safeEqual(body.client_secret, opts.clientSecret)
    ) {
      return sendError(res, 401, 'INVALID_CLIENT', 'Bad client credentials');
    }
    const token = randomBytes(24).toString('hex');
    tokens.set(token, Date.now() + opts.tokenTtlSec * 1000);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: opts.tokenTtlSec });
  });

  const requireToken: RequestHandler = (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expiresAt = tokens.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
      return sendError(res, 401, 'INVALID_TOKEN', 'Missing, unknown or expired token');
    }
    next();
  };

  return { tokenRouter, requireToken };
}
