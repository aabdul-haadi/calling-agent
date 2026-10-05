import type { HandoffView } from '@adk/shared';
import { signPayload } from '../tools/security';
import { DEFAULT_RETRY, backoffDelay } from '../tools/http';

export interface WebhookConfig {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Sends a signed handoff event to the contact-center. The event id is the handoff id, so a retry
 * (or a double click) is recognised and ignored by the receiver.
 */
export async function deliverHandoff(handoff: HandoffView, cfg: WebhookConfig): Promise<boolean> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = JSON.stringify({
    handoffId: handoff.id,
    conversationId: handoff.conversationId,
    clientId: handoff.clientId,
    reason: handoff.reason,
    summary: handoff.summary,
    sentiment: handoff.sentiment,
    customer: handoff.customerMasked,
    createdAt: handoff.createdAt,
  });

  for (let attempt = 0; attempt <= DEFAULT_RETRY.retries; attempt++) {
    const timestamp = String((cfg.now ?? Date.now)());
    try {
      const res = await doFetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-id': handoff.id,
          'x-timestamp': timestamp,
          'x-signature': signPayload(cfg.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true; // 201 = new, 200 = duplicate: both mean "delivered"
      if (res.status < 500 && res.status !== 429) return false; // our request is wrong; retrying cannot help
    } catch {
      // network error: fall through to retry
    }
    if (attempt < DEFAULT_RETRY.retries) await sleep(backoffDelay(attempt, DEFAULT_RETRY, Math.random));
  }
  return false;
}
