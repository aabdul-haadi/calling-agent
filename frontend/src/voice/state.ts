import type { KnowledgePassage, ServerEvent } from './protocol';

/** What the interface shows. Every state is driven by a real event, never by a timer pretending. */
export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'searching_policy'
  | 'speaking'
  | 'interrupted'
  | 'awaiting_confirmation'
  | 'executing_tool'
  | 'handing_off'
  | 'error'
  | 'disconnected';

export interface Line {
  id: string;
  who: 'you' | 'agent';
  text: string;
  /** For customer lines: the recognizer was unsure, so the agent will ask to repeat. */
  uncertain?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  /** Words being recognised right now. Tentative: earlier words may still change. */
  partial: string;
  lines: Line[];
  activeTool?: string;
  /** The policy passages the latest answer is based on (empty when it needed none). */
  sources: KnowledgePassage[];
  pendingApproval?: { summary: string; expiresAt: string };
  conversationId?: string;
  handedOff: boolean;
  /** A non-fatal problem worth showing (a failed phrase, a rejected frame). */
  notice?: string;
  /** Fatal problem: the session is over. */
  error?: { code: string; message: string };
  /** The reply is still being played in the browser. */
  playing: boolean;
}

/** Things that happen in the browser rather than on the server. */
export type LocalEvent =
  | { type: 'local.connecting' }
  | { type: 'local.mic_denied'; message: string }
  | { type: 'local.playback_ended' }
  | { type: 'local.closed' }
  | { type: 'local.reset' };

export const INITIAL: VoiceState = {
  status: 'idle',
  partial: '',
  lines: [],
  sources: [],
  handedOff: false,
  playing: false,
};

const idle = (s: VoiceState): VoiceStatus =>
  s.handedOff ? 'handing_off' : s.pendingApproval ? 'awaiting_confirmation' : 'listening';

/** Append the agent's words to its line for this turn, or start one. */
function addAgentText(lines: Line[], turn: number | undefined, text: string): Line[] {
  const id = `agent-${turn ?? 0}`;
  const last = lines[lines.length - 1];
  if (last && last.id === id) return [...lines.slice(0, -1), { ...last, text: last.text + text }];
  return [...lines, { id, who: 'agent', text: text.trimStart() }];
}

export function reduce(s: VoiceState, e: ServerEvent | LocalEvent): VoiceState {
  switch (e.type) {
    case 'local.reset':
      return INITIAL;
    case 'local.connecting':
      return { ...INITIAL, status: 'connecting' };
    case 'local.mic_denied':
      return { ...s, status: 'error', error: { code: 'microphone', message: e.message } };
    case 'local.closed':
      return s.status === 'error'
        ? s
        : { ...s, status: 'disconnected', playing: false, activeTool: undefined };
    case 'local.playback_ended':
      return s.status === 'speaking' || (s.playing && s.status !== 'interrupted')
        ? { ...s, playing: false, status: idle(s) }
        : { ...s, playing: false };

    case 'session.started':
      return { ...s, status: 'listening', conversationId: e.conversationId ?? s.conversationId };
    case 'session.conversation':
      return { ...s, conversationId: e.conversationId };
    case 'speech.started':
      return { ...s, status: 'transcribing', partial: '', notice: undefined };
    case 'transcript.partial':
      return s.status === 'transcribing' ? { ...s, partial: e.text } : s;
    case 'transcript.final':
      return {
        ...s,
        status: 'thinking',
        partial: '',
        // The next thing the customer says answers (or replaces) any approval that was waiting.
        pendingApproval: undefined,
        sources: [],
        lines: [
          ...s.lines,
          {
            id: `you-${e.turn ?? s.lines.length}`,
            who: 'you',
            text: e.text,
            uncertain: e.lowConfidence,
          },
        ],
      };
    case 'turn.discarded':
      return { ...s, status: idle(s), partial: '' };
    case 'agent.thinking':
      return s.status === 'thinking' || s.status === 'speaking' ? s : { ...s, status: 'thinking' };
    case 'knowledge.searching':
      return s.status === 'speaking' || s.status === 'interrupted' ? s : { ...s, status: 'searching_policy' };
    case 'knowledge.used':
      return {
        ...s,
        sources: e.passages ?? [],
        status: s.status === 'searching_policy' ? 'thinking' : s.status,
      };
    case 'tool.started':
      return { ...s, status: 'executing_tool', activeTool: e.tool };
    case 'tool.completed':
      return {
        ...s,
        activeTool: undefined,
        status: s.status === 'executing_tool' ? 'thinking' : s.status,
      };
    case 'approval.required':
      return { ...s, pendingApproval: { summary: e.summary, expiresAt: e.expiresAt } };
    case 'handoff.started':
      return { ...s, handedOff: true, status: s.status === 'speaking' ? s.status : 'handing_off' };
    case 'agent.text.delta':
      return { ...s, lines: addAgentText(s.lines, e.turn, e.text) };
    case 'agent.speaking':
      return { ...s, status: 'speaking', playing: true };
    case 'agent.speech.completed':
      return s;
    case 'agent.interrupted':
      return { ...s, status: 'interrupted', playing: false, activeTool: undefined, partial: '' };
    case 'turn.completed':
      // Audio may still be playing: the status changes when playback really ends.
      return s.playing ? s : { ...s, status: s.status === 'interrupted' ? s.status : idle(s) };
    case 'session.error':
      return e.fatal
        ? { ...s, status: 'error', error: { code: e.code, message: e.message } }
        : { ...s, notice: e.message };
    case 'session.closed':
      return s.status === 'error' ? s : { ...s, status: 'disconnected', playing: false };
    default:
      return s;
  }
}

export const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: 'Ready to start',
  connecting: 'Connecting…',
  listening: 'Listening',
  transcribing: 'Hearing you…',
  thinking: 'Thinking…',
  searching_policy: 'Searching policy documents…',
  speaking: 'Speaking: talk to interrupt',
  interrupted: 'Interrupted',
  awaiting_confirmation: 'Waiting for your yes or no',
  executing_tool: 'Checking a system…',
  handing_off: 'Handing over to a person',
  error: 'Something went wrong',
  disconnected: 'Disconnected',
};

/** What the agent is doing while a tool runs, in the customer's words. Unknown tools get a general phrase. */
const TOOL_PHRASES: Record<string, string> = {
  verify_customer: 'Checking your details…',
  get_booking: 'Checking your booking…',
  search_alternatives: 'Finding available flights…',
  change_flight: 'Preparing your change…',
  get_bill: 'Looking at your bill…',
  check_outage: 'Checking for outages…',
  transfer_to_human: 'Connecting you to a person…',
};
export const toolPhrase = (tool?: string): string => (tool && TOOL_PHRASES[tool]) || 'Checking a system…';
