import { z } from 'zod';
import { fail, ok, type ToolResult } from '@adk/shared';
import type { LlmCallOptions, LlmClient, LlmMessage, LlmRequest, LlmResponse } from './types';
import { CANCELLED_MESSAGE, postJson, postStream, readSse } from './http';

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

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z.object({
                      index: z.number().optional(),
                      id: z.string().optional(),
                      function: z
                        .object({ name: z.string().optional(), arguments: z.string().optional() })
                        .optional(),
                    }),
                  )
                  .optional(),
              })
              // Reasoning fields (`reasoning`, `reasoning_content`) are deliberately never read.
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalidJson: true }; // fails zod validation in the dispatcher, which the model then sees
  }
}

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

/** Reads an OpenAI-style event stream into one response, forwarding reply text as it arrives. */
async function readOpenAiStream(
  res: Response,
  call: LlmCallOptions,
): Promise<ToolResult<LlmResponse>> {
  let text = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  try {
    for await (const data of readSse(res)) {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // a keep-alive or a partial line: ignore
      }
      const chunk = streamChunkSchema.safeParse(json);
      if (!chunk.success) continue;
      const delta = chunk.data.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        call.onTextDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const cur = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(index, cur);
      }
    }
  } catch {
    return fail(
      'UNAVAILABLE',
      call.signal?.aborted ? CANCELLED_MESSAGE : 'The AI model stream was interrupted',
    );
  }
  if (call.signal?.aborted) return fail('UNAVAILABLE', CANCELLED_MESSAGE);
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([i, c]) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      input: parseToolArguments(c.args),
    }));
  return ok({ text: text.trim(), toolCalls });
}

export function createOpenAiClient(opts: {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible server (Ollama, Groq, OpenRouter...). Defaults to OpenAI itself. */
  baseUrl?: string;
  /** Sent as `reasoning_effort` (supported by reasoning models such as gpt-oss). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
}): LlmClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  // OpenAI's newer models want max_completion_tokens; other servers only understand max_tokens.
  const tokenField = opts.baseUrl ? 'max_tokens' : 'max_completion_tokens';
  return {
    async complete(req: LlmRequest, call?: LlmCallOptions) {
      const payload = {
        model: opts.model,
        [tokenField]: req.maxTokens ?? 1024,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        messages: toOpenAiMessages(req.system, req.messages),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      };
      const headers = { authorization: `Bearer ${opts.apiKey}` };
      const url = `${baseUrl}/chat/completions`;

      if (call?.onTextDelta) {
        const streamed = await postStream(
          url,
          headers,
          { ...payload, stream: true },
          { fetchImpl: opts.fetchImpl, signal: call.signal },
        );
        if (!streamed.ok) return streamed;
        return readOpenAiStream(streamed.data, call);
      }

      const res = await postJson(url, headers, payload, {
        fetchImpl: opts.fetchImpl,
        signal: call?.signal,
      });
      if (!res.ok) return res;
      const parsed = responseSchema.safeParse(res.data);
      if (!parsed.success) return fail('UNAVAILABLE', 'Unexpected response from the AI model');
      const msg = parsed.data.choices[0]!.message;
      const toolCalls = (msg.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        input: parseToolArguments(c.function.arguments),
      }));
      return ok({ text: (msg.content ?? '').trim(), toolCalls });
    },
  };
}
