import { z } from 'zod';
import { fail, ok, type ToolResult } from '@adk/shared';
import type { LlmCallOptions, LlmClient, LlmMessage, LlmRequest, LlmResponse } from './types';
import { CANCELLED_MESSAGE, postJson, postStream, readSse } from './http';

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

const streamEventSchema = z
  .object({
    type: z.string(),
    index: z.number().optional(),
    content_block: z
      .object({ type: z.string(), id: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        partial_json: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

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

/** Reads an Anthropic event stream into one response, forwarding reply text as it arrives. */
async function readAnthropicStream(
  res: Response,
  call: LlmCallOptions,
): Promise<ToolResult<LlmResponse>> {
  let text = '';
  const tools = new Map<number, { id: string; name: string; json: string }>();
  try {
    for await (const data of readSse(res)) {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const ev = streamEventSchema.safeParse(json);
      if (!ev.success) continue;
      const e = ev.data;
      if (e.type === 'error') return fail('UNAVAILABLE', 'The AI model stream reported an error');
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        tools.set(e.index ?? 0, {
          id: e.content_block.id ?? '',
          name: e.content_block.name ?? '',
          json: '',
        });
      } else if (e.type === 'content_block_delta' && e.delta) {
        if (e.delta.type === 'text_delta' && e.delta.text) {
          text += e.delta.text;
          call.onTextDelta?.(e.delta.text);
        } else if (e.delta.type === 'input_json_delta') {
          const t = tools.get(e.index ?? 0);
          if (t) t.json += e.delta.partial_json ?? '';
        }
      }
    }
  } catch {
    return fail(
      'UNAVAILABLE',
      call.signal?.aborted ? CANCELLED_MESSAGE : 'The AI model stream was interrupted',
    );
  }
  if (call.signal?.aborted) return fail('UNAVAILABLE', CANCELLED_MESSAGE);
  const toolCalls = [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, t]) => {
      let input: unknown = {};
      if (t.json.trim()) {
        try {
          input = JSON.parse(t.json);
        } catch {
          input = { __invalidJson: true };
        }
      }
      return { id: t.id, name: t.name, input };
    });
  return ok({ text: text.trim(), toolCalls });
}

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): LlmClient {
  return {
    async complete(req: LlmRequest, call?: LlmCallOptions) {
      const payload = {
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
      };
      const headers = { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' };
      const url = 'https://api.anthropic.com/v1/messages';

      if (call?.onTextDelta) {
        const streamed = await postStream(
          url,
          headers,
          { ...payload, stream: true },
          { fetchImpl: opts.fetchImpl, signal: call.signal },
        );
        if (!streamed.ok) return streamed;
        return readAnthropicStream(streamed.data, call);
      }

      const res = await postJson(url, headers, payload, {
        fetchImpl: opts.fetchImpl,
        signal: call?.signal,
      });
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
