import { Router } from 'express';
import express from 'express';
import { verifySignature } from '@adk/shared/hmac';
import { sendError, type MockOptions } from '../common';

interface QueueItem {
  eventId: string;
  receivedAt: string;
  status: 'pending' | 'accepted';
  payload: unknown;
}

/** Pretend contact-center: receives signed handoff webhooks and holds the human queue. */
export function createContactCenter(opts: MockOptions): Router {
  const queue = new Map<string, QueueItem>();
  const router = Router();

  // Raw body is needed: the signature covers the exact bytes that were sent.
  router.post('/handoffs', express.text({ type: '*/*', limit: '100kb' }), (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    const valid = verifySignature({
      secret: opts.webhookSecret,
      timestamp: req.header('x-timestamp') ?? '',
      signature: req.header('x-signature') ?? '',
      body,
    });
    if (!valid) return sendError(res, 401, 'BAD_SIGNATURE', 'Signature check failed');

    const eventId = req.header('x-event-id');
    if (!eventId) return sendError(res, 400, 'MISSING_EVENT_ID', 'x-event-id is required');
    if (queue.has(eventId)) return res.status(200).json({ data: { duplicate: true } });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendError(res, 400, 'BAD_JSON', 'Body must be JSON');
    }
    queue.set(eventId, {
      eventId,
      receivedAt: new Date().toISOString(),
      status: 'pending',
      payload,
    });
    res.status(201).json({ data: { duplicate: false } });
  });

  router.get('/handoffs', (_req, res) => res.json({ data: [...queue.values()] }));

  router.post('/handoffs/:eventId/accept', (req, res) => {
    const item = queue.get(req.params.eventId ?? '');
    if (!item) return sendError(res, 404, 'NOT_FOUND', 'No such handoff');
    item.status = 'accepted';
    res.json({ data: item });
  });

  return router;
}
