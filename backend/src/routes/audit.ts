import { Router } from 'express';
import { auditRepo, type Db } from '../database';
import { HttpError } from '../middleware';

export function auditRouter(db: Db): Router {
  const router = Router();

  /** Append-only history of proposals, approvals and changes for one conversation. */
  router.get('/conversations/:id/audit', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(400, 'INVALID_REQUEST', 'Bad conversation id');
    res.json({ data: await auditRepo.listAuditEvents(db, id) });
  });

  return router;
}
