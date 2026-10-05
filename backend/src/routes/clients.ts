import { Router } from 'express';
import type { ClientRegistry } from '../clients';
import { HttpError } from '../middleware';

export function clientsRouter(registry: ClientRegistry): Router {
  const router = Router();
  router.get('/clients', (_req, res) => res.json({ data: registry.summaries() }));
  router.get('/clients/:id', (req, res) => {
    const module = registry.get(req.params.id);
    if (!module) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    res.json({ data: module.config });
  });
  return router;
}
