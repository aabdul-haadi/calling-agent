import express, { type Express } from 'express';
import cors from 'cors';
import type { ChatService } from './agent';
import type { ClientRegistry } from './clients';
import type { Env } from './config';
import type { Db } from './database';
import type { Logger } from './logger';
import { errorHandler, HttpError, notFound, rateLimit, requestId } from './middleware';
import { chatRouter } from './routes/chat';
import { clientsRouter } from './routes/clients';
import { auditRouter } from './routes/audit';
import { handoffsRouter } from './routes/handoffs';
import { healthRouter } from './routes/health';
import { insightsRouter } from './routes/insights';
import { knowledgeRouter } from './routes/knowledge';
import type { KnowledgeService } from './knowledge/documents';
import type { Searcher } from './knowledge/retrieve';
import { testsRouter, type EvalService } from './routes/tests';
import { voiceRouter } from './routes/voice';
import { learningRouter } from './routes/learning';
import type { LearningService } from './learning';
import { assertTenantAccess, permissionForRequest, requestTenantId, requirePermission } from './auth/authorization';
import { createAuthenticator } from './auth/oidc';

export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Db;
  registry: ClientRegistry;
  chat: ChatService;
  evals: EvalService;
  knowledge: KnowledgeService;
  searcher: Searcher;
  learning?: LearningService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: deps.env.CORS_ORIGIN }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 600 }));

  app.use(healthRouter(deps.db));
  app.get('/auth/config', (_req, res) => {
    res.json({
      data: {
        mode: deps.env.AUTH_MODE,
        issuer: deps.env.OIDC_ISSUER ?? null,
      },
    });
  });
  app.use(createAuthenticator(deps.env, deps.registry));
  app.use((req, _res, next) => {
    try {
      const permission = permissionForRequest(req);
      if (!permission)
        throw new HttpError(404, 'NOT_FOUND', 'No such API operation.');
      const principal = requirePermission(req, permission);
      const tenantId = requestTenantId(req);
      if (tenantId) assertTenantAccess(principal, tenantId);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get('/auth/me', (req, res) => {
    const principal = requirePermission(req, 'auth:read');
    res.json({
      data: {
        subject: principal.sub,
        name: principal.name,
        email: principal.email,
        roles: principal.roles,
        tenantIds: principal.tenantIds.filter((id) => id !== '*'),
        permissions: principal.permissions,
        authentication: principal.service ?? deps.env.AUTH_MODE,
      },
    });
  });

  app.use(clientsRouter(deps.registry));
  app.use(chatRouter(deps.chat, deps.db));
  app.use(handoffsRouter(deps.db, deps.learning));
  app.use(auditRouter(deps.db));
  app.use(knowledgeRouter(deps.env, deps.registry, deps.knowledge, deps.searcher));
  app.use(insightsRouter(deps.db, deps.registry));
  app.use(voiceRouter(deps.env, deps.registry));
  app.use(testsRouter(deps.evals));
  if (deps.learning) app.use(learningRouter(deps.env, deps.registry, deps.learning));

  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
