import { Router } from 'express';
import { z } from 'zod';
import type { ChatService } from '../agent';
import { HttpError, rateLimit } from '../middleware';

const chatBody = z.object({
  clientId: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  channel: z.enum(['chat', 'voice']).optional(),
  simulator: z
    .object({ apiFailing: z.boolean(), latencyMs: z.number().int().min(0).max(3000) })
    .optional(),
});

const simulatorBody = z.object({
  apiFailing: z.boolean(),
  latencyMs: z.number().int().min(0).max(3000),
});
const latencyBody = z.object({ ms: z.number().min(0).max(60_000) });
const idParam = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return res.data;
}

export function chatRouter(chat: ChatService): Router {
  const router = Router();

  router.post('/chat', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    res.json({ data: await chat.chat(parse(chatBody, req.body)) });
  });

  router.get('/conversations/:id', async (req, res) => {
    res.json({ data: await chat.view(parse(idParam, req.params.id)) });
  });

  router.delete('/conversations/:id', async (req, res) => {
    res.json({ data: await chat.reset(parse(idParam, req.params.id)) });
  });

  router.patch('/conversations/:id/simulator', async (req, res) => {
    res.json({
      data: await chat.setSimulator(parse(idParam, req.params.id), parse(simulatorBody, req.body)),
    });
  });

  router.post('/conversations/:id/voice-latency', async (req, res) => {
    await chat.addVoiceLatency(parse(idParam, req.params.id), parse(latencyBody, req.body).ms);
    res.status(204).end();
  });

  return router;
}

export { parse as parseOrThrow };
