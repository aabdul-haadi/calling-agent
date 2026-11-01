import { Router } from 'express';
import { auditRepo, type Db } from '../database';
import { HttpError } from '../middleware';
import { conversationsRepo } from '../database';
import { assertTenantAccess } from '../auth/authorization';

export function auditRouter(db: Db): Router {
  const router = Router();

  /** Append-only history of proposals, approvals and changes for one conversation. */
  router.get('/conversations/:id/audit', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(400, 'INVALID_REQUEST', 'Bad conversation id');
    const conversation = await conversationsRepo.getConversation(db, id);
    if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'No such conversation');
    assertTenantAccess(req.principal!, conversation.clientId);
    res.json({ data: await auditRepo.listAuditEvents(db, id) });
  });

  return router;
}
