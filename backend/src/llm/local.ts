import { fail, ok, type ToolResult } from '@adk/shared';
import type { LlmCallOptions, LlmClient, LlmRequest, LlmResponse } from './types';

export interface LocalLlm extends LlmClient {
  health(): Promise<{ ok: boolean; adapterSha256?: string; base?: string; error?: string }>;
}

/**
 * A model served by `ml/serve_local.py` on this machine (a fine-tuned open model). It can only write
 * text: tool specs in the request are ignored and it never returns tool calls, so a candidate served
 * this way cannot run a business action however it was trained.
 */
export function createLocalLlm(opts: { url: string; timeoutMs?: number; fetchImpl?: typeof fetch }): LocalLlm {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, '');
  return {
    async complete(req: LlmRequest, call?: LlmCallOptions): Promise<ToolResult<LlmResponse>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
      const onAbort = () => controller.abort();
      call?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await doFetch(`${base}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system: req.system,
            messages: req.messages.flatMap((m) =>
              m.role === 'user' || m.role === 'assistant' ? [{ role: m.role, content: m.content }] : [],
            ),
            max_tokens: req.maxTokens ?? 200,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return fail('UNAVAILABLE', `The local model answered ${res.status}`);
        const body = (await res.json()) as { text?: string };
        const text = (body.text ?? '').trim();
        if (!text) return fail('UNAVAILABLE', 'The local model returned nothing');
        call?.onTextDelta?.(text);
        return ok({ text, toolCalls: [] });
      } catch (err) {
        return fail(
          'UNAVAILABLE',
          controller.signal.aborted ? 'The local model timed out' : `The local model is unreachable: ${String(err).slice(0, 100)}`,
        );
      } finally {
        clearTimeout(timer);
        call?.signal?.removeEventListener('abort', onAbort);
      }
    },
    async health() {
      try {
        const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
        return { ok: res.ok, ...((await res.json()) as object) };
      } catch (err) {
        return { ok: false, error: String(err).slice(0, 100) };
      }
    },
  };
}
