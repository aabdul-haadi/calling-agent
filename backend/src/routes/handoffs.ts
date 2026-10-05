import { Router } from 'express';
import { handoffsRepo, type Db } from '../database';
import { HttpError } from '../middleware';

export function handoffsRouter(db: Db): Router {
  const router = Router();

  router.get('/handoffs', async (req, res) => {
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    res.json({ data: await handoffsRepo.listHandoffs(db, clientId) });
  });

  router.post('/handoffs/:id/accept', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'INVALID_REQUEST', 'Bad handoff id');
    const accepted = await handoffsRepo.acceptHandoff(db, id);
    if (!accepted) throw new HttpError(404, 'NOT_FOUND', 'No such handoff');
    res.json({ data: accepted });
  });

  return router;
}
