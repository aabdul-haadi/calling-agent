import express, { type Express, type RequestHandler } from 'express';
import cors from 'cors';
import { createAirlineApi } from './airline-api';
import { createTelecomApi } from './telecom-api';
import { createContactCenter } from './contact-center';
import type { MockOptions } from './common';

export const defaultOptions = (overrides: Partial<MockOptions> = {}): MockOptions => ({
  failureRate: 0,
  latencyMs: 0,
  clientId: 'adk-backend',
  clientSecret: 'test-client-secret',
  webhookSecret: 'test-webhook-secret',
  tokenTtlSec: 3600,
  random: Math.random,
  ...overrides,
});

export function createMockApp(opts: MockOptions): Express {
  const app = express();
  app.use(cors());

  // All fake company state lives in these routers; rebuilding them resets every system to its seed.
  const build = () => ({
    airline: createAirlineApi(opts),
    telecom: createTelecomApi(opts),
    contact: createContactCenter(opts),
  });
  let systems = build();
  const via = (pick: (s: ReturnType<typeof build>) => express.Router): RequestHandler => (req, res, next) =>
    pick(systems)(req, res, next);

  // The contact-center needs raw text bodies, so JSON parsing is scoped to the other APIs.
  app.use('/contact-center', via((s) => s.contact));
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
  // Test helper: lets scenario runs start from a clean world. Dev tool only.
  app.post('/admin/reset', (_req, res) => {
    systems = build();
    res.json({ data: { reset: true } });
  });
  app.use('/airline', via((s) => s.airline));
  app.use('/telecom', via((s) => s.telecom));
  return app;
}
