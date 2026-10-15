import { Router } from 'express';
import { z } from 'zod';
import type { HandoffView } from '@adk/shared';
import { auditEvent, type AuditType } from '../agent/audit';
import { auditRepo, conversationsRepo, handoffsRepo, type Db } from '../database';
import { HttpError, rateLimit } from '../middleware';
import type { LearningService } from '../learning';

const replyBody = z.object({ message: z.string().trim().min(1).max(2000) });

/**
 * The human side of a handoff: accept it, reply to the customer, resolve it. There is no login in
 * this build, so anyone who can reach the API can act as the human agent.
 */
export function handoffsRouter(
  db: Db,
  learning?: Pick<LearningService, 'capture'>,
): Router {
  const router = Router();

  const idOf = (raw: unknown): string => {
    const id = String(raw);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'INVALID_REQUEST', 'Bad handoff id');
    return id;
  };
  const load = async (raw: unknown): Promise<HandoffView> => {
    const found = await handoffsRepo.getHandoff(db, idOf(raw));
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'No such handoff');
    return found;
  };
  const audit = (h: HandoffView, type: AuditType, data: Record<string, unknown> = {}) =>
    auditRepo.addAuditEvents(db, h.conversationId, h.clientId, [
      auditEvent(type, { handoffId: h.id, conversationId: h.conversationId, ...data }),
    ]);

  router.get('/handoffs', async (req, res) => {
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    res.json({ data: await handoffsRepo.listHandoffs(db, clientId) });
  });

  router.post('/handoffs/:id/accept', async (req, res) => {
    const current = await load(req.params.id);
    if (current.status === 'resolved')
      throw new HttpError(409, 'HANDOFF_CLOSED', 'This handoff is already resolved');
    const accepted = await handoffsRepo.acceptHandoff(db, current.id);
    if (!accepted) throw new HttpError(404, 'NOT_FOUND', 'No such handoff');
    if (current.status === 'pending') await audit(accepted, 'handoff_accepted');
    res.json({ data: accepted });
  });

  router.post('/handoffs/:id/reply', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    const current = await load(req.params.id);
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(400, 'INVALID_REQUEST', 'Write a reply of 1 to 2000 characters');
    if (current.status === 'pending')
      throw new HttpError(409, 'ACCEPT_FIRST', 'Accept the handoff before replying');
    if (current.status === 'resolved')
      throw new HttpError(409, 'HANDOFF_CLOSED', 'This handoff is already resolved');
    await conversationsRepo.addMessage(db, current.conversationId, 'human', parsed.data.message);
    await audit(current, 'human_reply', { characters: parsed.data.message.length });
    // The human's answer is a lead for review, never a label: it is stored redacted and unapproved.
    await learning?.capture.recordHumanReply(current.clientId, current.conversationId, parsed.data.message).catch(() => undefined);
    res.status(201).json({ data: { ok: true } });
  });

  router.post('/handoffs/:id/resolve', async (req, res) => {
    const current = await load(req.params.id);
    if (current.status === 'pending')
      throw new HttpError(409, 'ACCEPT_FIRST', 'Accept the handoff before resolving it');
    if (current.status === 'resolved') {
      res.json({ data: current });
      return;
    }
    const resolved = await handoffsRepo.resolveHandoff(db, current.id);
    if (!resolved) throw new HttpError(404, 'NOT_FOUND', 'No such handoff');
    await conversationsRepo.addMessage(
      db,
      current.conversationId,
      'human',
      'A human colleague marked this conversation as resolved. Start a new chat if you need anything else.',
    );
    await audit(resolved, 'handoff_resolved');
    await learning?.capture.recordResolution(resolved.clientId, resolved.conversationId, 'HANDOFF', 'resolved').catch(() => undefined);
    res.json({ data: resolved });
  });

  return router;
}
