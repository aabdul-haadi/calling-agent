import { fail } from '@adk/shared';
import { isConfigured, type Env } from '../config';
import { createAnthropicClient } from './anthropic';
import { createOpenAiClient } from './openai';
import type { LlmClient } from './types';

export * from './types';
export { createAnthropicClient, createOpenAiClient };

/**
 * Picks the provider from LLM_PROVIDER. A missing key yields a client that fails gracefully.
 * `openai` also covers any OpenAI-compatible server via OPENAI_BASE_URL (Ollama, Groq,
 * OpenRouter...). Local servers like Ollama need no real key.
 */
export function createLlm(env: Env): LlmClient {
  if (env.LLM_PROVIDER === 'openai' && env.OPENAI_BASE_URL) {
    return createOpenAiClient({
      apiKey: isConfigured(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : 'not-needed',
      model: env.LLM_MODEL,
      baseUrl: env.OPENAI_BASE_URL,
    });
  }
  const key = env.LLM_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!isConfigured(key)) {
    return {
      complete: async () =>
        fail('UNAVAILABLE', `No API key configured for ${env.LLM_PROVIDER}. Set it in .env.`),
    };
  }
  return env.LLM_PROVIDER === 'anthropic'
    ? createAnthropicClient({ apiKey: key, model: env.LLM_MODEL })
    : createOpenAiClient({ apiKey: key, model: env.LLM_MODEL });
}
