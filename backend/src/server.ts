import './config/load-dotenv';
import { loadEnv } from './config';
import { createLogger } from './logger';
import { createPostgresDb, runMigrations } from './database';
import { createApp } from './app';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const handle = await createPostgresDb(env.DATABASE_URL);

try {
  await runMigrations(handle, 'postgres');
} catch (err) {
  // Keep serving /health so the UI shows "degraded" and the developer sees what to fix.
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'database unavailable (is docker compose up?)');
}

const app = createApp({ env, logger, db: handle.db });
app.listen(env.BACKEND_PORT, () => logger.info(`backend listening on :${env.BACKEND_PORT}`));
