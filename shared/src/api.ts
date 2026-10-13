import type { ParsedClientConfig, Sentiment } from './client-config';

// Wire types shared by frontend and backend. API responses are always { data } or { error }.
export type ApiSuccess<T> = { data: T };
export type ApiFailure = { error: { code: string; message: string } };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type TraceStatus = 'ok' | 'warn' | 'error';

export interface TraceEvent {
  id: string;
  at: string;
  type: string;
  /** Plain-language label shown in the Live Trace. */
  label: string;
  status: TraceStatus;
  latencyMs?: number;
  /** Raw details, shown behind a "Show details" toggle. */
  detail?: unknown;
}

/** A change waiting for the customer's yes. Shown so the UI can ask for it; it cannot approve it. */
export interface PendingApprovalView {
  summary: string;
  expiresAt: string;
}

export interface ConversationStateView {
  phase?: string;
  pendingApproval?: PendingApprovalView;
  verified: boolean;
  journeyId: string;
  journeyStep: string;
  collected: Record<string, unknown>;
  handedOff: boolean;
}

export interface Citation {
  /** The document's name ("refunds", or "skylink-handbook.pdf"). */
  source: string;
  heading: string;
  snippet: string;
  score: number;
  /** Which stored document and version the passage came from. */
  documentId?: string;
  version?: number;
  /** Page numbers of a PDF passage (the first and the last page it covers). */
  page?: number;
  pageEnd?: number;
  /** Why it ranked: similarity by meaning, and by matching words (for debugging, never spoken). */
  match?: { vector?: number; keyword?: number; rerank?: number };
}

export type Channel = 'chat' | 'voice';

export interface SimulatorControls {
  apiFailing: boolean;
  latencyMs: number;
}

/** What the voice gateway knows about how the customer's words were recognised. */
export interface VoiceTranscriptMeta {
  /**
   * The speech recognizer was not confident (very short or unstable audio). A message like this is
   * never accepted as approval of a change, and the agent is told to ask again.
   */
  lowConfidence?: boolean;
}

export interface ChatRequest {
  clientId: string;
  conversationId?: string;
  message: string;
  channel?: Channel;
  /** Only sent by the voice gateway. */
  voice?: VoiceTranscriptMeta;
  /** Only used when this message starts a new conversation (scenario tests). */
  simulator?: SimulatorControls;
}

export interface HandoffSummary {
  lines: string[];
  intent: string;
  verified: boolean;
  tried: string[];
}

export interface HandoffView {
  id: string;
  conversationId: string;
  clientId: string;
  reason: string;
  summary: HandoffSummary;
  sentiment: Sentiment;
  customerMasked: string;
  status: 'pending' | 'accepted' | 'resolved';
  createdAt: string;
}

/** Where the time of one turn went. Offsets are milliseconds since the turn began. */
export interface StageTiming {
  stage: 'understand' | 'retrieve' | 'llm' | 'tool';
  /** For llm and tool stages, which call (tool name, or "step 2"). */
  label: string;
  startMs: number;
  ms: number;
  /** LLM stages only: until the first word of text arrived (when the model streams). */
  firstTokenMs?: number;
}
export interface TurnTimings {
  totalMs: number;
  stages: StageTiming[];
}

export interface ChatResponse {
  conversationId: string;
  /** The customer interrupted: the turn stopped early, nothing is said, and no reply is saved. */
  cancelled?: boolean;
  reply: string;
  state: ConversationStateView;
  trace: TraceEvent[];
  citations: Citation[];
  handoff?: HandoffView;
  timings?: TurnTimings;
}

export interface ConversationView {
  conversationId: string;
  clientId: string;
  messages: { role: 'user' | 'assistant' | 'human'; content: string; createdAt: string }[];
  state: ConversationStateView;
  trace: TraceEvent[];
  citations: Citation[];
  simulator: SimulatorControls;
}

export interface ClientSummary {
  id: string;
  displayName: string;
  initials: string;
  accent: 'sky' | 'violet';
  tagline: string;
  channels: ('chat' | 'voice')[];
}

export type ClientDetail = ParsedClientConfig;

export interface EvalResultView {
  id: string;
  scenarioId: string;
  title: string;
  passed: boolean;
  transcript: { role: 'user' | 'assistant'; content: string }[];
  expected: string;
  toolsCalled: string[];
  failures: string[];
  judgeReason: string;
}

export interface EvalRunView {
  id: string;
  clientId: string;
  status: 'running' | 'done' | 'error';
  total: number;
  passed: number;
  startedAt: string;
  finishedAt?: string;
  results: EvalResultView[];
}

export interface ConversationSummary {
  id: string;
  clientId: string;
  phase: string;
  journeyStep: string;
  verified: boolean;
  handedOff: boolean;
  awaitingApproval: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolStat {
  tool: string;
  calls: number;
  failures: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: 'audit' | 'handoff' | 'eval';
  label: string;
  clientId?: string;
  conversationId?: string;
}

/** Everything is computed from stored records. `null` means the system does not record it. */
export interface OverviewMetrics {
  clientId?: string;
  generatedAt: string;
  conversations: {
    total: number;
    last24h: number;
    handedOff: number;
    awaitingApproval: number;
    byPhase: Record<string, number>;
  };
  handoffs: { pending: number; accepted: number; resolved: number };
  tools: {
    total: number;
    failed: number;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    perTool: ToolStat[];
  };
  evals: {
    latest?: { id: string; clientId: string; passed: number; total: number; startedAt: string };
    history: { id: string; passed: number; total: number; startedAt: string }[];
  };
  /** Token counts and cost are not recorded by this system yet. */
  llmUsage: null;
  recentActivity: ActivityItem[];
}

export type KnowledgeStatus =
  'queued' | 'extracting' | 'indexing' | 'ready' | 'failed' | 'superseded';

export interface KnowledgeVersionView {
  id: string;
  version: number;
  status: KnowledgeStatus;
  active: boolean;
  chunks: number;
  pages: number | null;
  updatedAt: string;
}

export interface KnowledgeDoc {
  /** Absent for the plain policy files that predate the document store. */
  id?: string;
  source: string;
  title?: string | null;
  origin?: 'folder' | 'upload';
  version?: number;
  status?: KnowledgeStatus;
  /** What is happening right now, in plain words ("Reading page 12 of 55"). */
  stage?: string | null;
  progress?: number;
  pages?: number | null;
  ocrPages?: number;
  sizeBytes?: number | null;
  error?: { code: string; message: string } | null;
  warnings?: string[];
  chunks: number;
  headings: string[];
  characters: number;
  createdAt?: string;
  updatedAt: string;
  /** Older versions of the same document (their chunks are gone; the row is history). */
  versions?: KnowledgeVersionView[];
}

/** What a test question against the knowledge base found, and why. */
export interface KnowledgeSearchResult {
  question: string;
  /** The text actually searched (a short follow-up is joined to the topic it refers to). */
  searched: string;
  relevant: boolean;
  /** Plain-language reason for the decision. */
  reason: string;
  embedding: string;
  passages: Citation[];
  /** The best candidate even when it was rejected, with its scores. */
  closest?: Citation;
  timings: {
    embedMs: number;
    vectorMs: number;
    keywordMs: number;
    rerankMs?: number;
    totalMs: number;
  };
  /** Passages found before duplicates were removed and the relevance bar was applied. */
  considered: number;
}

/**
 * Events of one agent turn as it happens (POST /chat/stream sends them as NDJSON lines). They name
 * tools and their outcome only: never tool arguments, never model reasoning.
 */
export type TurnEvent =
  | {
      type: 'turn.started';
      conversationId: string;
      /** Voice channel only: how this company's agent should sound (style preferences, no business data). */
      speech?: {
        speaker?: string;
        speed: number;
        language: string;
        progressLine?: string;
        progress?: { knowledge?: string; tools: Record<string, string> };
      };
    }
  | { type: 'agent.thinking' }
  | { type: 'knowledge.searching' }
  | { type: 'turn.timing'; timings: TurnTimings }
  | { type: 'knowledge.used'; sources: string[] }
  | { type: 'tool.started'; tool: string }
  | { type: 'tool.completed'; tool: string; status: 'ok' | 'blocked' | 'error' }
  | { type: 'approval.required'; summary: string; expiresAt: string }
  | { type: 'agent.text.delta'; text: string }
  | { type: 'handoff.started'; reason: string };
