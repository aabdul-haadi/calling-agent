import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { SILENT_FRAME } from '@/avatar/lip-sync';
import { api } from '@/services/api';
import { VoiceClient, MicrophoneError, voiceEngineSupported } from '@/voice/client';
import { INITIAL, reduce } from '@/voice/state';
import { useAsync } from './use-async';

/**
 * The local voice engine: microphone and speakers in the browser, speech recognition and synthesis
 * in the voice gateway, and the same TypeScript agent that answers chat.
 *
 * Every piece of state comes from an event the gateway really sent (see voice/state.ts); levels
 * come from the real microphone and from the audio actually being played.
 */
export function useVoiceGateway(clientId: string) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const [levels, setLevels] = useState({ mic: 0, out: 0 });
  const [muted, setMuted] = useState(false);
  const clientRef = useRef<VoiceClient | undefined>(undefined);
  const status = useAsync(() => api.voiceStatus(), [clientId], 8000);

  const connected =
    state.status !== 'idle' && state.status !== 'disconnected' && state.status !== 'error';

  const start = useCallback(async () => {
    clientRef.current?.stop();
    dispatch({ type: 'local.connecting' });
    setMuted(false);
    try {
      const session = await api.voiceSession(clientId, state.conversationId);
      const client = new VoiceClient({
        url: session.url,
        token: session.token,
        conversationId: state.conversationId,
        onEvent: dispatch,
      });
      clientRef.current = client;
      await client.start();
    } catch (err) {
      clientRef.current = undefined;
      dispatch({
        type: 'local.mic_denied',
        message:
          err instanceof MicrophoneError || err instanceof Error
            ? err.message
            : 'Could not start the voice session.',
      });
    }
  }, [clientId, state.conversationId]);

  const stop = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = undefined;
  }, []);

  /** Stable reader for the avatar: polled per animation frame, never causes a re-render. */
  const lipFrame = useCallback(() => clientRef.current?.lipFrame() ?? SILENT_FRAME, []);

  const interrupt = useCallback(() => clientRef.current?.interrupt(), []);

  const toggleMute = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    client.setMuted(!client.isMuted);
    setMuted(client.isMuted);
  }, []);

  // Live levels, about 15 times a second, only while a call is on.
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      const c = clientRef.current;
      if (c) setLevels({ mic: c.micLevel(), out: c.outputLevel() });
    }, 66);
    return () => {
      clearInterval(timer);
      setLevels({ mic: 0, out: 0 });
    };
  }, [connected]);

  // Leaving the page ends the call.
  useEffect(
    () => () => {
      clientRef.current?.stop();
    },
    [],
  );

  return {
    state,
    levels,
    muted,
    connected,
    /** The browser can do it AND the gateway is running with its models loaded. */
    available: voiceEngineSupported() && status.data?.available === true,
    browserSupported: voiceEngineSupported(),
    gateway: status.data,
    gatewayLoading: status.loading,
    start,
    stop,
    interrupt,
    lipFrame,
    toggleMute,
    retryStatus: status.reload,
  };
}
