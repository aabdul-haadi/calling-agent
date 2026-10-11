import './config/load-dotenv';
import { loadEnv } from './config';
import { createLogger } from './logger';
import { connectDb, evalsRepo, runMigrations } from './database';
import { createApp } from './app';
import { createServices } from './container';
import { clientDir } from './clients';
import { createEmbeddingProvider, ingestClient } from './knowledge';
import { resolve } from 'node:path';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
const services = createServices(env, handle.db, logger);

try {
  await runMigrations(handle);
  const interrupted = await evalsRepo.failInterruptedRuns(handle.db);
  if (interrupted > 0) logger.warn({ interrupted }, 'marked interrupted eval runs as stopped');
  // Keep the policy index in sync with the files on disk (cheap: a few dozen chunks).
  const embeddings = createEmbeddingProvider(env);
  for (const m of services.registry.list()) {
    const n = await ingestClient(
      handle.db,
      embeddings,
      m.config.id,
      resolve(clientDir(m), m.config.knowledgeDir),
    ).catch(() => 0);
    logger.info({ client: m.config.id, chunks: n }, 'knowledge ingested');
  }
} catch (err) {
  // Keep serving /health so the UI shows "degraded" and the developer sees what to fix.
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'database unavailable (is docker compose up?)',
  );
}

const app = createApp({
  env,
  logger,
  db: handle.db,
  registry: services.registry,
  chat: services.chat,
  evals: services.evals,
});
const server = app.listen(env.BACKEND_PORT, () =>
  logger.info(`backend listening on :${env.BACKEND_PORT}`),
);

// Close the database cleanly on Ctrl+C / stop so the local database needs no crash recovery.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  handle
    .close()
    .catch(() => undefined)
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
