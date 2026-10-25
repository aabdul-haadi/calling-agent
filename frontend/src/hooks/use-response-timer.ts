import { useEffect, useRef, useState } from 'react';

const WORKING = new Set(['thinking', 'searching_policy', 'executing_tool']);

export interface ResponseTimer {
  /** Seconds the agent has been working on the current answer, counting up live. */
  liveMs: number | undefined;
  /** The finished turns, newest first: how long from the end of the question to the first sound. */
  history: number[];
  /** The agent is working on an answer right now. */
  running: boolean;
}

/**
 * Times how long the agent takes to respond. It starts when the customer's words are final and
 * the agent begins working, and stops at the first sound (or the first word, in chat). It reads the
 * real status the interface already has; nothing is estimated.
 */
export function useResponseTimer(status: string, stopOn: string = 'speaking'): ResponseTimer {
  const startedAt = useRef<number | undefined>(undefined);
  const [liveMs, setLiveMs] = useState<number | undefined>(undefined);
  const [history, setHistory] = useState<number[]>([]);
  const running = WORKING.has(status);

  useEffect(() => {
    if (running) {
      startedAt.current ??= performance.now();
      const id = window.setInterval(() => setLiveMs(performance.now() - startedAt.current!), 100);
      return () => window.clearInterval(id);
    }
    if (startedAt.current !== undefined) {
      if (status === stopOn) {
        const ms = performance.now() - startedAt.current;
        setLiveMs(ms);
        setHistory((h) => [ms, ...h].slice(0, 6));
      } else {
        setLiveMs(undefined); // interrupted or discarded: not a finished answer
      }
      startedAt.current = undefined;
    }
    return undefined;
  }, [running, status, stopOn]);

  return { liveMs, history, running };
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
