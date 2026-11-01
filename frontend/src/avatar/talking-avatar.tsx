import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentMode } from '@/agent3d/agent-state';
import { useReducedMotion } from '@/hooks/use-env';
import { cn } from '@/lib/utils';
import { avatarFor } from './avatar-config';
import type { LipFrame } from './lip-sync';
import type { AvatarLoadStatus } from './avatar-scene';

const AvatarScene = lazy(() => import('./avatar-scene'));

export interface TalkingAvatarProps {
  clientId: string;
  mode: AgentMode;
  /** Reads the audio actually being played. Without it the mouth stays closed. */
  lipFrame?: () => LipFrame;
  /** Shown while loading and instead of the 3D scene if it cannot run. */
  fallback: ReactNode;
}

/** True when a WebGL context can be created (cached: creating contexts is not free). */
let webgl: boolean | undefined;
export function webglAvailable(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const canvas = document.createElement('canvas');
    webgl = !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}
export function resetWebglProbe(): void {
  webgl = undefined;
}

class SceneBoundary extends Component<
  { onError: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onError(error.message);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The 3D character. The call keeps working if it cannot render: no WebGL, a model that fails to
 * load, or a lost graphics context all fall back to the plain status avatar, and the voice session
 * itself never depends on this component.
 */
export function TalkingAvatar({ clientId, mode, lipFrame, fallback }: TalkingAvatarProps) {
  const config = avatarFor(clientId);
  const reduced = useReducedMotion();
  const [reported, setReported] = useState<{ id: string; value: AvatarLoadStatus; detail?: string }>({
    id: clientId,
    value: 'loading',
  });
  // A status belongs to the character that reported it: after a tenant switch it starts over.
  const status = reported.id === clientId ? reported : { id: clientId, value: 'loading' as const };
  const [visible, setVisible] = useState(true);
  const [tabShown, setTabShown] = useState(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const box = useRef<HTMLDivElement>(null);
  const ready = status.value === 'ready';
  const supported = typeof document !== 'undefined' && webglAvailable();

  const onStatus = useCallback(
    (value: AvatarLoadStatus, detail?: string) => {
      // The fallback is silent to the caller, so leave a trace for whoever has to find out why.
      if (value === 'error') console.warn(`[avatar:${clientId}] 3D character unavailable: ${detail ?? 'unknown error'}`);
      setReported({ id: clientId, value, detail });
    },
    [clientId],
  );

  // Stop rendering when scrolled away or in a background tab.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onChange = () => setTabShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  if (!config || !supported || status.value === 'error') {
    const reason = !config
      ? undefined
      : !supported
        ? '3D is not available in this browser. Voice still works.'
        : 'The 3D character could not be shown. Voice still works.';
    return (
      <div className="absolute inset-0" data-avatar="fallback">
        {fallback}
        {reason && (
          <p
            role="note"
            className="absolute inset-x-2 top-1 rounded-md bg-card/90 px-2 py-1 text-center text-[11px] text-muted-foreground"
          >
            {reason}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={box}
      className="absolute inset-0 overflow-hidden rounded-xl"
      style={{ background: config.theme.background }}
      data-avatar={config.clientId}
    >
      {/* The still shows at once and fades away as the live character fades in. */}
      <img
        src={config.portraitUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn(
          'absolute inset-0 h-full w-full object-cover',
          !reduced && 'transition-opacity duration-500',
          ready ? 'opacity-0' : 'opacity-100',
        )}
      />
      <div
        className={cn('absolute inset-0', !reduced && 'transition-opacity duration-500', ready ? 'opacity-100' : 'opacity-0')}
      >
        <SceneBoundary onError={(detail) => onStatus('error', detail)}>
          <Suspense fallback={null}>
            <AvatarScene
              key={config.clientId}
              config={config}
              mode={mode}
              lipFrame={lipFrame}
              reducedMotion={reduced}
              active={visible && tabShown}
              onStatus={onStatus}
            />
          </Suspense>
        </SceneBoundary>
      </div>
      {status.value === 'loading' && (
        <p
          role="status"
          className="absolute inset-x-0 top-2 text-center text-[11px] font-medium text-foreground/70"
        >
          Loading {config.name}…
        </p>
      )}
      {config.credit && (
        <a
          href={config.credit.url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute right-1 top-1 max-w-[92%] truncate rounded bg-card/70 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:underline"
        >
          {config.credit.text}
        </a>
      )}
    </div>
  );
}
