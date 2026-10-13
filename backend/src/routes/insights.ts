import { Router } from 'express';
import type { ClientRegistry } from '../clients';
import { insightsRepo, type Db } from '../database';
import { HttpError } from '../middleware';

/** Read-only views the operations UI needs. Everything is computed from stored records. */
export function insightsRouter(db: Db, registry: ClientRegistry): Router {
  const router = Router();

  const knownClient = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined;
    if (!registry.get(value)) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    return value;
  };

  router.get('/overview', async (req, res) => {
    res.json({ data: await insightsRepo.computeOverview(db, knownClient(req.query.clientId)) });
  });

  router.get('/conversations', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    res.json({
      data: await insightsRepo.listConversations(db, knownClient(req.query.clientId), limit),
    });
  });

  return router;
}
