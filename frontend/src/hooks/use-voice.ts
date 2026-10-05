import { useCallback, useEffect, useRef, useState } from 'react';
import { formatForSpeech } from '@adk/shared';

// The Web Speech API is not in TypeScript's DOM lib, so we describe the small part we use.
interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const isVoiceSupported = (): boolean =>
  typeof window !== 'undefined' && Boolean(getRecognitionCtor()) && 'speechSynthesis' in window;

export interface VoiceOptions {
  /** Called with each finished customer sentence and the time (ms) the speech ended. */
  onUtterance: (text: string, endedAt: number) => void;
}

export function useVoice({ onUtterance }: VoiceOptions) {
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();

  const recRef = useRef<RecognitionLike | undefined>(undefined);
  const activeRef = useRef(false);
  const speakingRef = useRef(false);
  const onUtteranceRef = useRef(onUtterance);
  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  });
  const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream; raf: number } | undefined>(
    undefined,
  );

  const cancelSpeech = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const stopMeter = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    a.stream.getTracks().forEach((t) => t.stop());
    void a.ctx.close();
    audioRef.current = undefined;
    setLevel(0);
  }, []);

  /** Drives the waveform from the real microphone level. Optional: captions work without it. */
  const startMeter = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let last = 0;
      const tick = (time: number) => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        if (time - last > 60) {
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
          last = time;
        }
        if (audioRef.current) audioRef.current.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { ctx, stream, raf: requestAnimationFrame(tick) };
    } catch {
      // No meter: the waveform falls back to a gentle animation.
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError(
        'Voice needs a browser with speech recognition, such as Chrome or Edge. You can keep using text chat.',
      );
      return;
    }
    setError(undefined);
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript.trim();
        if (!text) continue;
        // Barge-in: the moment the customer starts talking, the agent stops talking.
        if (speakingRef.current) cancelSpeech();
        setCaption(text);
        if (r.isFinal) {
          onUtteranceRef.current(text, performance.now());
          setCaption('');
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError(
          'Microphone access was blocked. Allow it in the browser address bar to use voice.',
        );
        activeRef.current = false;
        setActive(false);
      }
    };
    // Chrome ends recognition after silence; restart while voice mode is on.
    rec.onend = () => {
      if (activeRef.current) {
        try {
          rec.start();
        } catch {
          // already started
        }
      }
    };
    recRef.current = rec;
    activeRef.current = true;
    setActive(true);
    rec.start();
    void startMeter();
  }, [cancelSpeech, startMeter]);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setCaption('');
    recRef.current?.stop();
    cancelSpeech();
    stopMeter();
  }, [cancelSpeech, stopMeter]);

  const speak = useCallback((text: string, onFirstAudio?: (at: number) => void) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(formatForSpeech(text));
    utterance.onstart = () => {
      speakingRef.current = true;
      setSpeaking(true);
      onFirstAudio?.(performance.now());
    };
    utterance.onend = utterance.onerror = () => {
      speakingRef.current = false;
      setSpeaking(false);
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {
    supported: isVoiceSupported(),
    active,
    speaking,
    caption,
    level,
    error,
    start,
    stop,
    speak,
    cancelSpeech,
  };
}
