import type {
  ApiResponse,
  ChatRequest,
  ChatResponse,
  ClientDetail,
  ClientSummary,
  ConversationSummary,
  ConversationView,
  EvalRunView,
  HandoffView,
  KnowledgeDoc,
  OverviewMetrics,
  SimulatorControls,
} from '@adk/shared';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError('NETWORK', "Can't reach the server. Is the backend running?");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => undefined)) as ApiResponse<T> | undefined;
  if (!body) throw new ApiError('BAD_RESPONSE', 'The server sent an unreadable response.');
  if ('error' in body) throw new ApiError(body.error.code, body.error.message);
  return body.data;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export interface AuditEntry {
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export const api = {
  health: () => call<{ status: string; db: string }>('/health'),
  clients: () => call<ClientSummary[]>('/clients'),
  client: (id: string) => call<ClientDetail>(`/clients/${id}`),
  chat: (req: ChatRequest) => call<ChatResponse>('/chat', json('POST', req)),
  conversation: (id: string) => call<ConversationView>(`/conversations/${id}`),
  resetConversation: (id: string) => call<ConversationView>(`/conversations/${id}`, json('DELETE')),
  setSimulator: (id: string, sim: SimulatorControls) =>
    call<ConversationView>(`/conversations/${id}/simulator`, json('PATCH', sim)),
  voiceLatency: (id: string, ms: number) =>
    call<void>(`/conversations/${id}/voice-latency`, json('POST', { ms })),
  handoffs: (clientId?: string) =>
    call<HandoffView[]>(`/handoffs${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`),
  acceptHandoff: (id: string) => call<HandoffView>(`/handoffs/${id}/accept`, json('POST')),
  replyHandoff: (id: string, message: string) =>
    call<{ ok: true }>(`/handoffs/${id}/reply`, json('POST', { message })),
  resolveHandoff: (id: string) => call<HandoffView>(`/handoffs/${id}/resolve`, json('POST')),
  startRun: (clientId: string) => call<{ runId: string }>('/tests/run', json('POST', { clientId })),
  runs: (clientId: string) =>
    call<EvalRunView[]>(`/tests/runs?clientId=${encodeURIComponent(clientId)}`),
  run: (id: string) => call<EvalRunView>(`/tests/runs/${id}`),
  overview: (clientId?: string) =>
    call<OverviewMetrics>(
      `/overview${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`,
    ),
  conversations: (clientId?: string, limit = 30) =>
    call<ConversationSummary[]>(
      `/conversations?limit=${limit}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`,
    ),
  audit: (conversationId: string) => call<AuditEntry[]>(`/conversations/${conversationId}/audit`),
  knowledge: (clientId: string) =>
    call<KnowledgeDoc[]>(`/clients/${encodeURIComponent(clientId)}/knowledge`),
};
