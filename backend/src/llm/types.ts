import type { ToolResult } from '@adk/shared';

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw, untrusted arguments chosen by the model. Validated by the dispatcher. */
  input: unknown;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmCallOptions {
  /** Cancels the request at once (the customer interrupted). Never retried after it fires. */
  signal?: AbortSignal;
  /**
   * When given, the model's reply text is delivered through this callback as it is generated, so
   * a voice reply can start before the model has finished. The returned text is still complete.
   * Reasoning, if the model produces any, is never passed on.
   */
  onTextDelta?: (text: string) => void;
}

/** Provider-neutral model client. Failures are returned as values, never thrown. */
export interface LlmClient {
  complete(req: LlmRequest, opts?: LlmCallOptions): Promise<ToolResult<LlmResponse>>;
}
