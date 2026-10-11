import express, { type Express } from 'express';
import cors from 'cors';
import type { ChatService } from './agent';
import type { ClientRegistry } from './clients';
import type { Env } from './config';
import type { Db } from './database';
import type { Logger } from './logger';
import { errorHandler, notFound, rateLimit, requestId } from './middleware';
import { chatRouter } from './routes/chat';
import { clientsRouter } from './routes/clients';
import { auditRouter } from './routes/audit';
import { handoffsRouter } from './routes/handoffs';
import { healthRouter } from './routes/health';
import { insightsRouter } from './routes/insights';
import { testsRouter, type EvalService } from './routes/tests';

export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Db;
  registry: ClientRegistry;
  chat: ChatService;
  evals: EvalService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: deps.env.CORS_ORIGIN }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 600 }));

  app.use(healthRouter(deps.db));
  app.use(clientsRouter(deps.registry));
  app.use(chatRouter(deps.chat));
  app.use(handoffsRouter(deps.db));
  app.use(auditRouter(deps.db));
  app.use(insightsRouter(deps.db, deps.registry));
  app.use(testsRouter(deps.evals));

  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
