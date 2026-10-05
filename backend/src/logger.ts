import pino, { type Logger } from 'pino';
import { maskPII } from './tools/security/pii';

export type { Logger };

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    // Every object that is logged passes through the PII masker first.
    formatters: {
      log: (obj) => maskPII(obj) as Record<string, unknown>,
    },
    redact: ['*.apiKey', '*.authorization', '*.secret', 'headers.authorization'],
  });
}

/** Child logger that stamps every line with the conversation id. */
export const forConversation = (logger: Logger, conversationId: string): Logger =>
  logger.child({ conversationId });
