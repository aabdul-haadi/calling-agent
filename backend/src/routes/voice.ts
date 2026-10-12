import { Router } from 'express';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import { isConfigured, type Env } from '../config';
import { HttpError, rateLimit } from '../middleware';
import { signVoiceToken } from '../voice/token';

const sessionBody = z.object({
  clientId: z.string().min(1).max(64),
  conversationId: z.string().uuid().optional(),
});

/**
 * Entry point for the optional Python voice gateway. The gateway only carries audio: every
 * decision and action still runs in this backend. The browser asks here for a short-lived token,
 * then connects to the gateway with it.
 */
export function voiceRouter(env: Env, registry: ClientRegistry): Router {
  const router = Router();
  const secret = isConfigured(env.VOICE_GATEWAY_SECRET) ? env.VOICE_GATEWAY_SECRET : undefined;

  router.post('/voice/session', rateLimit({ windowMs: 60_000, max: 20 }), (req, res) => {
    const parsed = sessionBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', 'clientId is required');
    const module = registry.get(parsed.data.clientId);
    if (!module) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    if (!module.config.channels.includes('voice'))
      throw new HttpError(
        400,
        'CHANNEL_NOT_SUPPORTED',
        `${module.config.displayName} does not support voice`,
      );
    if (!secret)
      throw new HttpError(
        503,
        'VOICE_NOT_CONFIGURED',
        'The voice gateway is not configured (set VOICE_GATEWAY_SECRET in .env)',
      );
    const { token, expiresAt } = signVoiceToken(secret, {
      cid: parsed.data.clientId,
      conv: parsed.data.conversationId,
    });
    res.json({ data: { url: env.VOICE_GATEWAY_URL, token, expiresAt, protocol: 1 } });
  });

  /** Is the gateway running and are its models loaded? The UI uses this to pick the voice engine. */
  router.get('/voice/status', async (_req, res) => {
    const base = { configured: Boolean(secret), url: env.VOICE_GATEWAY_URL };
    if (!secret) {
      res.json({ data: { ...base, available: false } });
      return;
    }
    try {
      const r = await fetch(`${env.VOICE_GATEWAY_HTTP_URL}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const body = (await r.json()) as { ready?: boolean; asr?: string; tts?: string };
      res.json({
        data: { ...base, available: r.ok && body.ready === true, asr: body.asr, tts: body.tts },
      });
    } catch {
      res.json({ data: { ...base, available: false } });
    }
  });

  return router;
}
