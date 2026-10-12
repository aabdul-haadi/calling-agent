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
  source: string;
  heading: string;
  snippet: string;
  score: number;
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

export interface ChatResponse {
  conversationId: string;
  /** The customer interrupted: the turn stopped early, nothing is said, and no reply is saved. */
  cancelled?: boolean;
  reply: string;
  state: ConversationStateView;
  trace: TraceEvent[];
  citations: Citation[];
  handoff?: HandoffView;
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

export interface KnowledgeDoc {
  source: string;
  chunks: number;
  headings: string[];
  characters: number;
  updatedAt: string;
}

/**
 * Events of one agent turn as it happens (POST /chat/stream sends them as NDJSON lines). They name
 * tools and their outcome only: never tool arguments, never model reasoning.
 */
export type TurnEvent =
  | { type: 'turn.started'; conversationId: string }
  | { type: 'agent.thinking' }
  | { type: 'knowledge.used'; sources: string[] }
  | { type: 'tool.started'; tool: string }
  | { type: 'tool.completed'; tool: string; status: 'ok' | 'blocked' | 'error' }
  | { type: 'approval.required'; summary: string; expiresAt: string }
  | { type: 'agent.text.delta'; text: string }
  | { type: 'handoff.started'; reason: string };
