import type { Db } from '../database';
import { handoffsRepo } from '../database';
import type { LlmClient } from '../llm';
import type { Logger } from '../logger';
import { buildSummary, customerLabel } from './summary';
import { REASON_TEXT } from './triggers';
import type { HandoffService } from './types';
import { deliverHandoff, type WebhookConfig } from './webhook';

export interface HandoffServiceDeps {
  db: Db;
  logger: Logger;
  webhook: WebhookConfig;
  llm?: LlmClient;
}

export function createHandoffService(deps: HandoffServiceDeps): HandoffService {
  return {
    async create(input) {
      const summary = await buildSummary(deps.llm, input);
      const handoff = await handoffsRepo.insertHandoff(deps.db, {
        conversationId: input.conversationId,
        clientId: input.clientId,
        reason: REASON_TEXT[input.reason],
        summary,
        sentiment: input.state.lastSentiment,
        customerMasked: customerLabel(input),
      });
      // The row above IS the queue the UI reads, so a webhook failure never loses a handoff.
      const delivered = await deliverHandoff(handoff, deps.webhook);
      if (delivered) await handoffsRepo.markDelivered(deps.db, handoff.id);
      else
        deps.logger.warn({ conversationId: input.conversationId }, 'handoff webhook not delivered');
      deps.logger.info(
        { conversationId: input.conversationId, reason: input.reason, delivered },
        'handoff created',
      );
      return handoff;
    },
  };
}
