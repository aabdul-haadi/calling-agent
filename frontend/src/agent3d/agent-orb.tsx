import { Component, lazy, Suspense, useRef, type CSSProperties, type ReactNode } from 'react';
import { canUseWebGL, useIsActive, useParticleBudget, useReducedMotion } from '@/hooks/use-env';
import { cn } from '@/lib/utils';
import { describeAgent, MODE_META, type AgentMode } from './agent-state';

// The 3D scene (three.js) is a separate chunk: pages that never show it never download it.
const AgentScene = lazy(() => import('./agent-scene'));

/** Static look-alike: concentric rings and a core, themed by the same mode colour. */
export function AgentFallback({ mode, accent }: { mode: AgentMode; accent: 'sky' | 'violet' }) {
  const hsl =
    accent === 'violet' && ['idle', 'listening', 'speaking'].includes(mode)
      ? '262 92% 79%'
      : MODE_META[mode].hsl;
  const style = { '--orb': hsl } as CSSProperties;
  return (
    <div
      aria-hidden="true"
      style={style}
      className="relative flex h-full w-full items-center justify-center"
    >
      {[0.92, 0.7, 0.5].map((s, i) => (
        <span
          key={s}
          className="absolute rounded-full border"
          style={{
            width: `${s * 100}%`,
            height: `${s * 100}%`,
            borderColor: 'hsl(var(--orb) / 0.35)',
            animation: `adk-spin ${18 + i * 9}s linear infinite ${i % 2 ? 'reverse' : ''}`,
            transform: `rotateX(${60 - i * 12}deg)`,
          }}
        />
      ))}
      <span
        className="absolute h-[34%] w-[34%] rounded-full"
        style={{
          background:
            'radial-gradient(circle at 35% 30%, hsl(var(--orb) / 0.95), hsl(var(--orb) / 0.35) 60%, transparent 72%)',
          boxShadow: '0 0 60px hsl(var(--orb) / 0.4)',
          animation: 'adk-breathe 4s ease-in-out infinite',
        }}
      />
    </div>
  );
}

class SceneBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface AgentOrbProps {
  mode: AgentMode;
  /** Real mic level 0-1 (listening only). */
  level?: number;
  accent?: 'sky' | 'violet';
  agentName: string;
  /** Tool shown while the mode is "executing". */
  toolLabel?: string;
  className?: string;
  /** Hide the status caption (the page already shows one). */
  hideCaption?: boolean;
}

/**
 * The agent visual. Uses WebGL when available and the user has not asked for less motion;
 * otherwise shows the static fallback. The status caption is real text, so the state is
 * available to screen readers and in browsers without WebGL.
 */
export function AgentOrb({
  mode,
  level = 0,
  accent = 'sky',
  agentName,
  toolLabel,
  className,
  hideCaption,
}: AgentOrbProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const active = useIsActive(wrap);
  const particles = useParticleBudget();
  const webgl = canUseWebGL();
  const fallback = <AgentFallback mode={mode} accent={accent} />;
  const caption = describeAgent(mode, agentName, toolLabel);

  return (
    <div ref={wrap} className={cn('relative isolate aspect-square w-full', className)}>
      <div className="absolute inset-0">
        {webgl ? (
          <SceneBoundary fallback={fallback}>
            <Suspense fallback={fallback}>
              <AgentScene
                mode={mode}
                level={level}
                accent={accent}
                particles={particles}
                still={reduced}
                active={active}
              />
            </Suspense>
          </SceneBoundary>
        ) : (
          fallback
        )}
      </div>
      <p
        role="status"
        className={cn(
          'absolute inset-x-0 bottom-1 mx-auto w-fit max-w-[92%] truncate rounded-full border border-border bg-card/80 px-3 py-1 text-xs font-medium backdrop-blur-sm',
          hideCaption && 'sr-only',
        )}
      >
        <span
          aria-hidden="true"
          className="mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle"
          style={{ background: `hsl(${MODE_META[mode].hsl})` }}
        />
        {caption}
      </p>
    </div>
  );
}
