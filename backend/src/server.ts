import './config/load-dotenv';
import { loadEnv } from './config';
import { createLogger } from './logger';
import { createPostgresDb, runMigrations } from './database';
import { createApp } from './app';
import { createServices } from './container';
import { clientDir } from './clients';
import { createEmbeddingProvider, ingestClient } from './knowledge';
import { resolve } from 'node:path';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const handle = await createPostgresDb(env.DATABASE_URL);
const services = createServices(env, handle.db, logger);

try {
  await runMigrations(handle, 'postgres');
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
app.listen(env.BACKEND_PORT, () => logger.info(`backend listening on :${env.BACKEND_PORT}`));
