import { useEffect, useState, type RefObject } from 'react';

/** True when the user asked the OS to reduce motion. Updates live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Is the element on screen AND the tab visible? Expensive animation pauses when either is false. */
export function useIsActive(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true), {
      threshold: 0.05,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return inView && tabVisible;
}

let webgl: boolean | undefined;
/** Can this browser create a WebGL context? Cached, because probing is not free. */
export function canUseWebGL(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const canvas = document.createElement('canvas');
    webgl = !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Fewer particles on small screens and weak machines. Decided once per mount. */
export function useParticleBudget(): number {
  const [count] = useState(() => {
    const small = typeof window !== 'undefined' && window.innerWidth < 768;
    const weak = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4;
    return small || weak ? 160 : 380;
  });
  return count;
}
