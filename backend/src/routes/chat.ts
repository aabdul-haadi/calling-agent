import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ChatService } from '../agent';
import type { TurnEvent } from '@adk/shared';
import { HttpError, rateLimit } from '../middleware';
import type { Db } from '../database';
import { conversationsRepo } from '../database';
import { assertTenantAccess } from '../auth/authorization';

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
const idempotencyKeyHeader = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

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

function requiredIdempotencyKey(value: unknown): string {
  const key = parse(idempotencyKeyHeader, value);
  if (!key)
    throw new HttpError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Set an Idempotency-Key header for each logical chat turn.',
    );
  return key;
}

export function chatRouter(chat: ChatService, db: Db): Router {
  const router = Router();
  const assertConversationScope = async (
    id: string,
    principal: NonNullable<Request['principal']>,
    clientId?: string,
  ) => {
    const conversation = await conversationsRepo.getConversation(db, id);
    if (!conversation || (clientId && conversation.clientId !== clientId))
      throw new HttpError(404, 'NOT_FOUND', 'No such conversation');
    assertTenantAccess(principal, conversation.clientId);
    return conversation;
  };

  router.post('/chat', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    const idempotencyKey = requiredIdempotencyKey(req.header('idempotency-key'));
    const body = parse(chatBody, req.body);
    assertTenantAccess(req.principal!, body.clientId);
    if (body.conversationId)
      await assertConversationScope(body.conversationId, req.principal!, body.clientId);
    res.json({
      data: await chat.chat(body, { idempotencyKey }),
    });
  });

  /**
   * One turn as a stream of newline-delimited JSON events. Closing the connection (the customer
   * interrupted) cancels the turn at its next safe point; a tool call already running finishes.
   * The last line is `turn.completed`, `turn.cancelled` or `turn.error`.
   */
  router.post('/chat/stream', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    const body = parse(chatBody, req.body);
    const idempotencyKey = requiredIdempotencyKey(req.header('idempotency-key'));
    assertTenantAccess(req.principal!, body.clientId);
    if (body.conversationId)
      await assertConversationScope(body.conversationId, req.principal!, body.clientId);
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
      const out = await chat.chat(body, { signal: abort.signal, onEvent, idempotencyKey });
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
    const id = parse(idParam, req.params.id);
    await assertConversationScope(id, req.principal!);
    res.json({ data: await chat.view(id) });
  });

  router.delete('/conversations/:id', async (req, res) => {
    const id = parse(idParam, req.params.id);
    await assertConversationScope(id, req.principal!);
    res.json({ data: await chat.reset(id) });
  });

  router.patch('/conversations/:id/simulator', async (req, res) => {
    const id = parse(idParam, req.params.id);
    await assertConversationScope(id, req.principal!);
    res.json({
      data: await chat.setSimulator(id, parse(simulatorBody, req.body)),
    });
  });

  router.post('/conversations/:id/voice-latency', async (req, res) => {
    const id = parse(idParam, req.params.id);
    await assertConversationScope(id, req.principal!);
    await chat.addVoiceLatency(id, parse(latencyBody, req.body).ms);
    res.status(204).end();
  });

  return router;
}

export { parse as parseOrThrow };
