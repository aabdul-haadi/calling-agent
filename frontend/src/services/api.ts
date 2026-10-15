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
  KnowledgeSearchResult,
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

/** Who is reviewing, and the optional review token. Kept in this browser only. */
export function learningCredentials(): { reviewer: string; token: string } {
  try {
    return {
      reviewer: localStorage.getItem('adk.reviewer') ?? '',
      token: localStorage.getItem('adk.reviewToken') ?? '',
    };
  } catch {
    return { reviewer: '', token: '' };
  }
}

function learningInit(init: RequestInit = {}): RequestInit {
  const { reviewer, token } = learningCredentials();
  return {
    ...init,
    headers: {
      ...(reviewer ? { 'x-reviewer': reviewer } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
}

/** Learning console types: what the server sends for review, gaps, datasets and releases. */
export interface LearningTurn {
  id: string;
  channel: 'voice' | 'chat';
  intent: string;
  sentiment: string;
  customerText: string;
  aiReply: string;
  humanReply: string | null;
  sources: { source: string; page: number | null; weak: boolean }[];
  asksPolicy: boolean;
  abstained: boolean;
  handoffReason: string | null;
  resolution: string;
  rating: number | null;
  correction: string | null;
  flags: string[];
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'excluded';
  reviewer: string | null;
  approvedReply: string | null;
  split: 'train' | 'eval';
  createdAt: string;
}
export interface LearningGap {
  id: string;
  label: string;
  examples: string[];
  occurrences: number;
  channels: string[];
  status: string;
  suggestion: { recommendation?: string; unverifiedHumanAnswers?: string[]; nearest?: { source: string; heading: string; page?: number } | null };
}
export interface LearningDataset {
  id: string;
  version: number;
  kind: string;
  stats: { examples: number; byChannel: { voice: number; chat: number }; rejectedByChecks: number; minExamples: number };
  sha256: string;
  createdAt: string;
}
export interface LearningGate {
  name: string;
  pass: boolean;
  detail: string;
}
export interface LearningRelease {
  id: string;
  kind: 'retrieval' | 'behavior' | 'intent_model';
  channel: 'voice' | 'chat' | 'both';
  version: number;
  status: string;
  note: string | null;
  params: { rollout: number; config: unknown };
  evaluation: { passed?: boolean; gates?: LearningGate[] };
  createdBy: string | null;
  deployedAt: string | null;
  createdAt: string;
}
export interface LearningJob {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  result: Record<string, unknown>;
  error: string | null;
  startedAt: string;
}
export interface LearningOverview {
  review: Record<string, number>;
  capture: { queued: number; stored: number; duplicates: number; excluded: number; failed: number };
  byChannel: Record<string, number>;
  flags: Record<string, number>;
  openGaps: number;
  datasets: number;
  shadow: Record<string, { n: number; agree: number; agreement: number }>;
  thresholds: { minSftExamples: number; minIntentExamples: number; retentionDays: number };
}

export interface AuditEntry {
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface VoiceStatus {
  configured: boolean;
  available: boolean;
  url: string;
  asr?: string;
  tts?: string;
}

export interface VoiceSession {
  url: string;
  token: string;
  expiresAt: string;
  protocol: number;
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
  voiceStatus: () => call<VoiceStatus>('/voice/status'),
  voiceSession: (clientId: string, conversationId?: string) =>
    call<VoiceSession>('/voice/session', json('POST', { clientId, conversationId })),
  knowledge: (clientId: string) =>
    call<KnowledgeDoc[]>(`/clients/${encodeURIComponent(clientId)}/knowledge`),
  /** Sends the PDF as the request body; the server reads it in the background and reports progress. */
  uploadKnowledge: (clientId: string, file: File) =>
    call<{ document: KnowledgeDoc; unchanged: boolean }>(
      `/clients/${encodeURIComponent(clientId)}/knowledge/documents?name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file, headers: { 'content-type': 'application/pdf' } },
    ),
  reindexKnowledge: (clientId: string, id: string, reextract = false) =>
    call<KnowledgeDoc>(
      `/clients/${encodeURIComponent(clientId)}/knowledge/documents/${id}/reindex`,
      json('POST', { reextract }),
    ),
  retryKnowledge: (clientId: string, id: string) =>
    call<KnowledgeDoc>(
      `/clients/${encodeURIComponent(clientId)}/knowledge/documents/${id}/retry`,
      json('POST'),
    ),
  deleteKnowledge: (clientId: string, id: string) =>
    call<{ removed: string }>(
      `/clients/${encodeURIComponent(clientId)}/knowledge/documents/${id}`,
      json('DELETE'),
    ),
  learning: {
    overview: (c: string) => call<LearningOverview>(`/clients/${encodeURIComponent(c)}/learning/overview`, learningInit()),
    turns: (c: string, status: string) =>
      call<LearningTurn[]>(`/clients/${encodeURIComponent(c)}/learning/turns?status=${status}&limit=100`, learningInit()),
    review: (c: string, id: string, body: object) =>
      call<LearningTurn>(`/clients/${encodeURIComponent(c)}/learning/turns/${id}/review`, learningInit(json('POST', body))),
    gaps: (c: string) => call<LearningGap[]>(`/clients/${encodeURIComponent(c)}/learning/gaps`, learningInit()),
    gapStatus: (c: string, id: string, status: string) =>
      call<LearningGap>(`/clients/${encodeURIComponent(c)}/learning/gaps/${id}/status`, learningInit(json('POST', { status }))),
    datasets: (c: string) => call<LearningDataset[]>(`/clients/${encodeURIComponent(c)}/learning/datasets`, learningInit()),
    buildDataset: (c: string) =>
      call<{ dataset: LearningDataset; meetsThreshold: boolean; threshold: number }>(`/clients/${encodeURIComponent(c)}/learning/datasets`, learningInit(json('POST', {}))),
    datasetUrl: (c: string, id: string) => `${BASE}/clients/${encodeURIComponent(c)}/learning/datasets/${id}/download`,
    releases: (c: string) => call<LearningRelease[]>(`/clients/${encodeURIComponent(c)}/learning/releases`, learningInit()),
    release: (c: string, id: string, action: 'evaluate' | 'shadow' | 'deploy' | 'reject') =>
      call<LearningRelease>(`/clients/${encodeURIComponent(c)}/learning/releases/${id}/${action}`, learningInit(json('POST', {}))),
    rollback: (c: string, kind: string, channel: string) =>
      call<unknown>(`/clients/${encodeURIComponent(c)}/learning/releases/rollback`, learningInit(json('POST', { kind, channel }))),
    tuneRetrieval: (c: string) =>
      call<{ release?: LearningRelease; note: string }>(`/clients/${encodeURIComponent(c)}/learning/releases/retrieval/tune`, learningInit(json('POST', {}))),
    trainIntent: (c: string) =>
      call<LearningRelease>(`/clients/${encodeURIComponent(c)}/learning/models/intent/train`, learningInit(json('POST', {}))),
    proposeBehavior: (c: string, body: object) =>
      call<LearningRelease>(`/clients/${encodeURIComponent(c)}/learning/releases/behavior`, learningInit(json('POST', body))),
    jobs: (c: string) => call<LearningJob[]>(`/clients/${encodeURIComponent(c)}/learning/jobs`, learningInit()),
    runCycle: (c: string) => call<Record<string, unknown>>(`/clients/${encodeURIComponent(c)}/learning/cycle`, learningInit(json('POST', {}))),
  },
  searchKnowledge: (clientId: string, question: string, history: string[] = []) =>
    call<KnowledgeSearchResult>(
      `/clients/${encodeURIComponent(clientId)}/knowledge/search`,
      json('POST', { question, history }),
    ),
};
