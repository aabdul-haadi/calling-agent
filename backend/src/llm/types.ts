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

/** Provider-neutral model client. Failures are returned as values, never thrown. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<ToolResult<LlmResponse>>;
}
