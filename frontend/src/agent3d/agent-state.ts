/**
 * What the agent visual should show, derived ONLY from signals the app really has.
 * No rendering code here: the 3D scene and the CSS fallback both read the same result.
 */
export type AgentMode =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'awaiting'
  | 'speaking'
  | 'success'
  | 'error'
  | 'handoff';

export interface AgentSignals {
  /** A request is in flight to the backend. */
  sending: boolean;
  /** The last request failed (cleared by the next send). */
  error?: string;
  /** The conversation was handed to a human. */
  handedOff: boolean;
  /** The server is waiting for the customer's yes. */
  awaitingApproval: boolean;
  /** Voice mode is on and the microphone is open. */
  voiceActive: boolean;
  /** The browser is speaking a reply. */
  voiceSpeaking: boolean;
  /** Tool being replayed from the turn that just finished, if any. */
  activeTool?: string;
  /** A change was just completed by the server (conversation phase COMPLETED). */
  justCompleted: boolean;
}

export const IDLE_SIGNALS: AgentSignals = {
  sending: false,
  handedOff: false,
  awaitingApproval: false,
  voiceActive: false,
  voiceSpeaking: false,
  justCompleted: false,
};

/** Highest priority first. A failure or a handoff outranks everything that is merely animation. */
export function deriveAgentMode(s: AgentSignals): AgentMode {
  if (s.error) return 'error';
  if (s.handedOff) return 'handoff';
  if (s.sending) return 'thinking';
  if (s.activeTool) return 'executing';
  if (s.voiceSpeaking) return 'speaking';
  if (s.awaitingApproval) return 'awaiting';
  if (s.voiceActive) return 'listening';
  if (s.justCompleted) return 'success';
  return 'idle';
}

export interface ModeMeta {
  label: string;
  /** Linear-ish sRGB triplet used by the 3D scene (0-1). */
  color: [number, number, number];
  /** HSL used by the CSS fallback. */
  hsl: string;
  /** How fast the rings turn (1 = resting). */
  spin: number;
  /** How fast particles drift. */
  drift: number;
  /** Core brightness. */
  glow: number;
}

const ICE: [number, number, number] = [0.43, 0.88, 1];
const VIOLET: [number, number, number] = [0.7, 0.58, 1];

export const MODE_META: Record<AgentMode, ModeMeta> = {
  idle: { label: 'Idle', color: ICE, hsl: '196 100% 67%', spin: 1, drift: 0.6, glow: 0.7 },
  listening: {
    label: 'Listening',
    color: [0.36, 1, 0.9],
    hsl: '172 100% 68%',
    spin: 1.4,
    drift: 1,
    glow: 1,
  },
  thinking: {
    label: 'Thinking',
    color: [0.55, 0.62, 1],
    hsl: '230 100% 73%',
    spin: 3.4,
    drift: 2.6,
    glow: 1.1,
  },
  executing: {
    label: 'Running a tool',
    color: [0.75, 0.95, 1],
    hsl: '195 100% 82%',
    spin: 2.4,
    drift: 1.6,
    glow: 1.3,
  },
  awaiting: {
    label: 'Waiting for your approval',
    color: [1, 0.72, 0.28],
    hsl: '38 100% 62%',
    spin: 0.45,
    drift: 0.3,
    glow: 0.9,
  },
  speaking: {
    label: 'Speaking',
    color: [0.43, 0.9, 1],
    hsl: '194 100% 68%',
    spin: 1.6,
    drift: 1.2,
    glow: 1.1,
  },
  success: {
    label: 'Done',
    color: [0.4, 0.92, 0.6],
    hsl: '148 70% 58%',
    spin: 1.2,
    drift: 0.8,
    glow: 1.2,
  },
  error: {
    label: 'Something went wrong',
    color: [1, 0.4, 0.4],
    hsl: '0 100% 70%',
    spin: 0.5,
    drift: 0.4,
    glow: 0.8,
  },
  handoff: {
    label: 'With a human',
    color: VIOLET,
    hsl: '262 100% 79%',
    spin: 0.8,
    drift: 0.5,
    glow: 0.9,
  },
};

/** The human-readable status line, also used as the accessible label. */
export function describeAgent(mode: AgentMode, name: string, tool?: string): string {
  switch (mode) {
    case 'executing':
      return tool ? `${name} is running: ${tool}` : `${name} is running a tool`;
    case 'awaiting':
      return `${name} is waiting for your approval`;
    case 'handoff':
      return `${name} handed this conversation to a human`;
    case 'error':
      return `${name} hit a problem`;
    case 'thinking':
      return `${name} is thinking`;
    case 'listening':
      return `${name} is listening`;
    case 'speaking':
      return `${name} is speaking`;
    case 'success':
      return `${name} finished the request`;
    default:
      return `${name} is ready`;
  }
}
