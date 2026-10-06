import { describe, expect, it } from 'vitest';
import { loadEnv } from '@backend/config';
import { createLlm, createOpenAiClient } from '@backend/llm';

const base = { MOCK_CLIENT_ID: 'a', MOCK_CLIENT_SECRET: 'b', WEBHOOK_SECRET: 'long-enough-secret' };

function fakeFetch(body: unknown) {
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: (init?.headers as Record<string, string>).authorization,
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const reply = { choices: [{ message: { content: 'hello there' } }] };

describe('OpenAI-compatible providers (Ollama, Groq, OpenRouter)', () => {
  it('calls the configured base URL and uses max_tokens for non-OpenAI servers', async () => {
    const { fetchImpl, calls } = fakeFetch(reply);
    const llm = createOpenAiClient({
      apiKey: 'k',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434/v1/',
      fetchImpl,
    });
    const res = await llm.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    });
    expect(res).toEqual({ ok: true, data: { text: 'hello there', toolCalls: [] } });
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]?.body.max_tokens).toBe(50);
    expect(calls[0]?.body.max_completion_tokens).toBeUndefined();
  });

  it('keeps using api.openai.com and max_completion_tokens by default', async () => {
    const { fetchImpl, calls } = fakeFetch(reply);
    const llm = createOpenAiClient({ apiKey: 'k', model: 'gpt', fetchImpl });
    await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.body.max_completion_tokens).toBe(50);
  });

  it('parses tool calls from an OpenAI-style response', async () => {
    const { fetchImpl } = fakeFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', function: { name: 'get_booking', arguments: '{"bookingRef":"SK1001"}' } },
            ],
          },
        },
      ],
    });
    const llm = createOpenAiClient({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1', fetchImpl });
    const res = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(res).toMatchObject({
      ok: true,
      data: { toolCalls: [{ id: 'c1', name: 'get_booking', input: { bookingRef: 'SK1001' } }] },
    });
  });

  it('a local server needs no API key, but plain OpenAI still does', async () => {
    const local = createLlm(
      loadEnv({
        ...base,
        LLM_PROVIDER: 'openai',
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        LLM_MODEL: 'llama3.1',
      }),
    );
    // Not "no API key configured": it tried to reach the (not running) local server instead.
    const res = await local.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).not.toMatch(/No API key/);

    const hosted = createLlm(loadEnv({ ...base, LLM_PROVIDER: 'openai' }));
    const res2 = await hosted.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res2.ok === false && res2.message).toMatch(/No API key/);
  });
});
