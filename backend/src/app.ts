import express, { type Express } from 'express';
import cors from 'cors';
import type { Env } from './config';
import type { Db } from './database';
import type { Logger } from './logger';
import { errorHandler, notFound, rateLimit, requestId } from './middleware';
import { healthRouter } from './routes/health';

export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Db;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: deps.env.CORS_ORIGIN }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  app.use(healthRouter(deps.db));

  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
