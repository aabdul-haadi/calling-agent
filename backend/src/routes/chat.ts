import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { ChatService } from '../agent';
import type { TurnEvent } from '@adk/shared';
import { HttpError, rateLimit } from '../middleware';

const chatBody = z.object({
  clientId: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  channel: z.enum(['chat', 'voice']).optional(),
  voice: z.object({ lowConfidence: z.boolean().optional() }).strict().optional(),
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

  /**
   * One turn as a stream of newline-delimited JSON events. Closing the connection (the customer
   * interrupted) cancels the turn at its next safe point; a tool call already running finishes.
   * The last line is `turn.completed`, `turn.cancelled` or `turn.error`.
   */
  router.post('/chat/stream', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    const body = parse(chatBody, req.body);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    const turnId = randomUUID();
    let seq = 0;
    let spokeText = false;
    const send = (event: Record<string, unknown>) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify({ seq: ++seq, turnId, ...event })}
`);
    };
    const onEvent = (e: TurnEvent) => {
      if (e.type === 'agent.text.delta') spokeText = true;
      send(e);
    };

    try {
      const out = await chat.chat(body, { signal: abort.signal, onEvent });
      if (out.cancelled || abort.signal.aborted) {
        send({ type: 'turn.cancelled', conversationId: out.conversationId });
      } else {
        // Paths that never reach the model (a queued handoff, a canned reply) still have to be said.
        if (!spokeText && out.reply) send({ type: 'agent.text.delta', text: out.reply });
        send({
          type: 'turn.completed',
          conversationId: out.conversationId,
          reply: out.reply,
          state: out.state,
          ...(out.handoff ? { handoff: { reason: out.handoff.reason } } : {}),
        });
      }
    } catch (err) {
      const known = err instanceof HttpError ? err : undefined;
      send({
        type: 'turn.error',
        code: known?.code ?? 'INTERNAL',
        message: known?.message ?? 'Something went wrong on our side',
      });
    } finally {
      res.end();
    }
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
