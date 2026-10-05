import { Router } from 'express';
import { pingDb, type Db } from '../database';

export function healthRouter(db: Db): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const dbUp = await pingDb(db);
    // 200 even when the DB is down so the UI can show a clear "degraded" state instead of an error.
    res.json({ data: { status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down' } });
  });
  return router;
}
