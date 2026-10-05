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

export interface ConversationStateView {
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

export interface ChatRequest {
  clientId: string;
  conversationId?: string;
  message: string;
  channel?: Channel;
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
  status: 'pending' | 'accepted';
  createdAt: string;
}

export interface ChatResponse {
  conversationId: string;
  reply: string;
  state: ConversationStateView;
  trace: TraceEvent[];
  citations: Citation[];
  handoff?: HandoffView;
}

export interface ConversationView {
  conversationId: string;
  clientId: string;
  messages: { role: 'user' | 'assistant'; content: string; createdAt: string }[];
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
