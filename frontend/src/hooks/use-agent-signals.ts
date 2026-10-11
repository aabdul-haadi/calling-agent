import { useEffect, useMemo, useState } from 'react';
import type { ConversationStateView, TraceEvent } from '@adk/shared';
import { deriveAgentMode, type AgentMode } from '@/agent3d/agent-state';

export interface AgentSignalInput {
  sending: boolean;
  error?: string;
  state?: ConversationStateView;
  handedOff: boolean;
  trace: TraceEvent[];
  voiceActive?: boolean;
  voiceSpeaking?: boolean;
}

const REPLAY_STEP_MS = 650;
const SUCCESS_MS = 3500;

/** Tool names (in order) from the trace events of the newest turn: everything after the last intent event. */
export function lastTurnTools(trace: TraceEvent[]): string[] {
  const start = trace.map((t) => t.type).lastIndexOf('intent');
  return trace
    .slice(start === -1 ? 0 : start)
    .filter((t) => t.type === 'tool')
    .map((t) => (t.detail as { tool?: string } | undefined)?.tool)
    .filter((t): t is string => typeof t === 'string');
}

/**
 * Turns real app state into the agent's mode.
 *
 * The backend answers a turn in one response (no streaming), so tool activity cannot be shown
 * live. Instead the tools that actually ran in the turn are replayed one by one right after the
 * response arrives, and the caption says so. Nothing is shown that did not happen.
 */
export function useAgentSignals(input: AgentSignalInput): {
  mode: AgentMode;
  activeTool?: string;
  replaying: boolean;
} {
  const tools = useMemo(() => lastTurnTools(input.trace), [input.trace]);
  const turnKey = input.trace.at(-1)?.id;
  const [activeTool, setActiveTool] = useState<string>();
  const [justCompleted, setJustCompleted] = useState(false);

  // Replay the tools of the turn that just finished.
  useEffect(() => {
    if (!turnKey || tools.length === 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    tools.forEach((tool, i) => {
      timers.push(setTimeout(() => setActiveTool(tool), i * REPLAY_STEP_MS));
    });
    timers.push(setTimeout(() => setActiveTool(undefined), tools.length * REPLAY_STEP_MS));
    return () => timers.forEach(clearTimeout);
  }, [turnKey, tools]);

  const completed = input.state?.phase === 'COMPLETED';
  useEffect(() => {
    if (!completed) return;
    const on = setTimeout(() => setJustCompleted(true), 0);
    const off = setTimeout(() => setJustCompleted(false), SUCCESS_MS);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [completed, turnKey]);

  const mode = deriveAgentMode({
    sending: input.sending,
    error: input.error,
    handedOff: input.handedOff,
    awaitingApproval: Boolean(input.state?.pendingApproval),
    voiceActive: Boolean(input.voiceActive),
    voiceSpeaking: Boolean(input.voiceSpeaking),
    activeTool,
    justCompleted: justCompleted && completed,
  });
  return { mode, activeTool, replaying: activeTool !== undefined };
}
