import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import type { LlmClient, LlmMessage, LlmRequest } from './types';
import { postJson } from './http';

const responseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
});

type Block = Record<string, unknown>;

/** Anthropic wants tool results as blocks inside ONE user message, so consecutive tool turns are merged. */
export function toAnthropicMessages(
  messages: LlmMessage[],
): { role: string; content: string | Block[] }[] {
  const out: { role: string; content: string | Block[] }[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? [])
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
      out.push({ role: 'assistant', content: blocks });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): LlmClient {
  return {
    async complete(req: LlmRequest) {
      const res = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: opts.model,
          max_tokens: req.maxTokens ?? 1024,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
        },
        { fetchImpl: opts.fetchImpl },
      );
      if (!res.ok) return res;
      const parsed = responseSchema.safeParse(res.data);
      if (!parsed.success) return fail('UNAVAILABLE', 'Unexpected response from the AI model');
      let text = '';
      const toolCalls = [];
      for (const b of parsed.data.content) {
        if ('text' in b && b.type === 'text') text += (b as { text: string }).text;
        if (b.type === 'tool_use') {
          const tu = b as { id: string; name: string; input: unknown };
          toolCalls.push({ id: tu.id, name: tu.name, input: tu.input });
        }
      }
      return ok({ text: text.trim(), toolCalls });
    },
  };
}
