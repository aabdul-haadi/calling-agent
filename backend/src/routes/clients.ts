import { Router } from 'express';
import type { ClientRegistry } from '../clients';
import { HttpError } from '../middleware';

export function clientsRouter(registry: ClientRegistry): Router {
  const router = Router();
  router.get('/clients', (req, res) => {
    const principal = req.principal!;
    const clients = registry.summaries().filter(
      (client) => principal.tenantIds.includes('*') || principal.tenantIds.includes(client.id),
    );
    res.json({ data: clients });
  });
  router.get('/clients/:id', (req, res) => {
    const module = registry.get(req.params.id);
    if (!module) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    res.json({ data: module.config });
  });
  return router;
}
