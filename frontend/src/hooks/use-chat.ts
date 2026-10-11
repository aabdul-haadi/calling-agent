import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Channel,
  Citation,
  ConversationStateView,
  HandoffView,
  SimulatorControls,
  TraceEvent,
} from '@adk/shared';
import { api } from '@/services/api';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant' | 'human';
  content: string;
}

/** How often a handed-over conversation checks for the human's replies. */
export const HUMAN_POLL_MS = 3000;

let counter = 0;
const nextId = () => `m${++counter}`;

/** All chat logic lives here so components stay presentational. */
export function useChat(clientId: string) {
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [state, setState] = useState<ConversationStateView>();
  const [citations, setCitations] = useState<Citation[]>([]);
  const [handoff, setHandoff] = useState<HandoffView>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [simulator, setSim] = useState<SimulatorControls>({ apiFailing: false, latencyMs: 0 });
  // Ref copy so `send` always sees the latest id even when called twice quickly (voice).
  const idRef = useRef<string | undefined>(undefined);

  const send = useCallback(
    async (text: string, channel: Channel = 'chat'): Promise<string | undefined> => {
      const message = text.trim();
      if (!message || sending) return undefined;
      setError(undefined);
      setMessages((m) => [...m, { id: nextId(), role: 'user', content: message }]);
      setSending(true);
      try {
        const res = await api.chat({
          clientId,
          conversationId: idRef.current,
          message,
          channel,
          simulator: idRef.current ? undefined : simulator,
        });
        idRef.current = res.conversationId;
        setConversationId(res.conversationId);
        // After a handoff the agent is silent once a human has accepted: an empty reply adds nothing.
        if (res.reply) {
          setMessages((m) => [...m, { id: nextId(), role: 'assistant', content: res.reply }]);
        }
        setTrace((t) => [...t, ...res.trace]);
        setState(res.state);
        if (res.citations.length > 0) setCitations(res.citations);
        if (res.handoff) setHandoff(res.handoff);
        return res.reply;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong');
        return undefined;
      } finally {
        setSending(false);
      }
    },
    [clientId, sending, simulator],
  );

  // Once a person has the conversation, their replies are saved on the server: fetch them.
  const handedOff = Boolean(state?.handedOff) || Boolean(handoff);
  const sendingRef = useRef(false);
  useEffect(() => {
    sendingRef.current = sending;
  });
  useEffect(() => {
    if (!handedOff || !conversationId) return;
    const timer = setInterval(() => {
      if (sendingRef.current) return;
      api
        .conversation(conversationId)
        .then((view) =>
          setMessages(
            view.messages.map((m, i) => ({ id: `srv-${i}`, role: m.role, content: m.content })),
          ),
        )
        .catch(() => undefined);
    }, HUMAN_POLL_MS);
    return () => clearInterval(timer);
  }, [handedOff, conversationId]);

  const reset = useCallback(async () => {
    const id = idRef.current;
    setMessages([]);
    setTrace([]);
    setState(undefined);
    setCitations([]);
    setHandoff(undefined);
    setError(undefined);
    if (!id) return;
    try {
      await api.resetConversation(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset');
    }
  }, []);

  const updateSimulator = useCallback(async (next: SimulatorControls) => {
    setSim(next);
    if (!idRef.current) return;
    try {
      await api.setSimulator(idRef.current, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update demo controls');
    }
  }, []);

  /** Adds a locally-measured event (voice latency) to the trace and saves it on the server. */
  const addVoiceLatency = useCallback(async (ms: number) => {
    const event: TraceEvent = {
      id: `voice-${nextId()}`,
      at: new Date().toISOString(),
      type: 'voice',
      label: 'Voice latency: speech end to first audio',
      status: ms < 1500 ? 'ok' : 'warn',
      latencyMs: Math.round(ms),
    };
    setTrace((t) => [...t, event]);
    if (idRef.current) await api.voiceLatency(idRef.current, ms).catch(() => undefined);
  }, []);

  return {
    conversationId,
    messages,
    trace,
    state,
    citations,
    handoff,
    sending,
    error,
    simulator,
    send,
    reset,
    updateSimulator,
    addVoiceLatency,
  };
}
