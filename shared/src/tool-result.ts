// Every tool returns this shape. Errors are values, not exceptions, so the agent loop
// can always explain a failure to the customer instead of crashing.
export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'AUTH_REQUIRED'
  | 'INVALID_ARGS'
  | 'UNAVAILABLE'
  | 'RULE_BLOCKED';

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorCode; message: string };

export const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });

export const fail = (error: ToolErrorCode, message: string): ToolResult<never> => ({
  ok: false,
  error,
  message,
});
