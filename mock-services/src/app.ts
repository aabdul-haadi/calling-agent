import express, { type Express } from 'express';
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
  // The contact-center needs raw text bodies, so JSON parsing is scoped to the other APIs.
  app.use('/contact-center', createContactCenter(opts));
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
  app.use('/airline', createAirlineApi(opts));
  app.use('/telecom', createTelecomApi(opts));
  return app;
}
