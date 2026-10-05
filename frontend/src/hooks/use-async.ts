import { useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data on mount, when `deps` change, and on `reload`. Optional polling keeps screens like
 * the inbox fresh. `loading` is derived (result belongs to a different key), so no state is set
 * synchronously inside the effect.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = [], pollMs?: number): AsyncState<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    const run = () =>
      loadRef
        .current()
        .then((data) => !cancelled && setResult({ key, data }))
        .catch(
          (e: unknown) =>
            !cancelled &&
            setResult((prev) => ({
              key,
              data: prev?.key === key ? prev.data : undefined,
              error: e instanceof Error ? e.message : 'Unknown error',
            })),
        );
    void run();
    const timer = pollMs ? setInterval(() => void run(), pollMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, tick, pollMs]);

  const current = result?.key === key ? result : undefined;
  return { data: current?.data, error: current?.error, loading: current === undefined, reload: () => setTick((t) => t + 1) };
}
