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
export function createLlm(env: Env, model: string = env.LLM_MODEL): LlmClient {
  if (env.LLM_PROVIDER === 'openai' && env.OPENAI_BASE_URL) {
    return createOpenAiClient({
      apiKey: isConfigured(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : 'not-needed',
      model,
      baseUrl: env.OPENAI_BASE_URL,
      reasoningEffort: env.LLM_REASONING_EFFORT,
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
    ? createAnthropicClient({ apiKey: key, model })
    : createOpenAiClient({
        apiKey: key,
        model,
        reasoningEffort: env.LLM_REASONING_EFFORT,
      });
}

/**
 * A separate, usually smaller and faster, model for the one-line classification of each message
 * (set LLM_CLASSIFIER_MODEL). Undefined when not set: the main model classifies, as before.
 */
export function createClassifierLlm(env: Env): LlmClient | undefined {
  return env.LLM_CLASSIFIER_MODEL ? createLlm(env, env.LLM_CLASSIFIER_MODEL) : undefined;
}
