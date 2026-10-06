import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import type { LlmClient, LlmMessage, LlmRequest } from './types';
import { postJson } from './http';

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
});

export function toOpenAiMessages(
  system: string,
  messages: LlmMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

export function createOpenAiClient(opts: {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible server (Ollama, Groq, OpenRouter...). Defaults to OpenAI itself. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): LlmClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  // OpenAI's newer models want max_completion_tokens; other servers only understand max_tokens.
  const tokenField = opts.baseUrl ? 'max_tokens' : 'max_completion_tokens';
  return {
    async complete(req: LlmRequest) {
      const res = await postJson(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${opts.apiKey}` },
        {
          model: opts.model,
          [tokenField]: req.maxTokens ?? 1024,
          messages: toOpenAiMessages(req.system, req.messages),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        },
        { fetchImpl: opts.fetchImpl },
      );
      if (!res.ok) return res;
      const parsed = responseSchema.safeParse(res.data);
      if (!parsed.success) return fail('UNAVAILABLE', 'Unexpected response from the AI model');
      const msg = parsed.data.choices[0]!.message;
      const toolCalls = (msg.tool_calls ?? []).map((c) => {
        const parseArgs = (): unknown => {
          try {
            return JSON.parse(c.function.arguments);
          } catch {
            return { __invalidJson: true }; // fails zod validation in the dispatcher, which the model then sees
          }
        };
        return { id: c.id, name: c.function.name, input: parseArgs() };
      });
      return ok({ text: (msg.content ?? '').trim(), toolCalls });
    },
  };
}
