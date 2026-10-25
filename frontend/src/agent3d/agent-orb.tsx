import {
  AlertTriangle,
  Check,
  Hand,
  Headset,
  LoaderCircle,
  Mic,
  Search,
  UserRound,
  Volume2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useReducedMotion } from '@/hooks/use-env';
import { cn } from '@/lib/utils';
import { describeAgent, MODE_META, type AgentMode } from './agent-state';

/**
 * The agent's presence: a persona avatar with a status ring, the way a contact-centre
 * agent appears in professional support tools. Everything is driven by real signals
 * (mode, mic level); nothing is decorative animation.
 */

type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'accent-2';

const MODE_VIEW: Record<
  AgentMode,
  { tone: Tone; icon: LucideIcon; busy?: boolean; live?: boolean }
> = {
  idle: { tone: 'accent', icon: Headset },
  listening: { tone: 'accent', icon: Mic, live: true },
  thinking: { tone: 'accent', icon: LoaderCircle, busy: true },
  searching: { tone: 'accent', icon: Search, busy: true },
  executing: { tone: 'accent', icon: Wrench, busy: true },
  awaiting: { tone: 'warn', icon: Hand },
  speaking: { tone: 'accent', icon: Volume2, live: true },
  success: { tone: 'ok', icon: Check },
  error: { tone: 'danger', icon: AlertTriangle },
  handoff: { tone: 'accent-2', icon: UserRound },
};

const toneVar = (t: Tone) => `hsl(var(--${t}))`;

/** Static rendering (also used when motion is reduced). Kept as a named export for callers. */
export function AgentFallback({ mode }: { mode: AgentMode; accent?: 'sky' | 'violet' }) {
  return <Avatar mode={mode} name="" level={0} still />;
}

function Avatar({
  mode,
  name,
  level,
  still,
  compact,
}: {
  mode: AgentMode;
  name: string;
  level: number;
  still?: boolean;
  compact?: boolean;
}) {
  const view = MODE_VIEW[mode];
  const Icon = view.icon;
  const color = toneVar(view.tone);
  const R = 46;
  const C = 2 * Math.PI * R;
  const initial = name.trim().charAt(0).toUpperCase() || 'A';
  const ripple = view.live && !still;
  const style = { '--tone': color } as CSSProperties;

  return (
    <div aria-hidden="true" style={style} className="relative h-full w-full">
      {/* Voice ripple: grows with the real mic level. */}
      {ripple && (
        <span
          className="absolute inset-[9%] rounded-full border-2"
          style={{
            borderColor: 'var(--tone)',
            transform: `scale(${1 + Math.min(1, level) * 0.12})`,
            transition: 'transform 90ms linear',
            animation: 'adk-ripple 1.8s var(--ease-out) infinite',
          }}
        />
      )}

      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <circle cx="50" cy="50" r={R} fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="var(--tone)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={view.busy ? `${C * 0.22} ${C}` : `${C} ${C}`}
          style={{
            transformOrigin: '50% 50%',
            transform: 'rotate(-90deg)',
            animation: view.busy && !still ? 'adk-spin 1.4s linear infinite' : undefined,
            transition: 'stroke 220ms var(--ease-out)',
          }}
        />
      </svg>

      {/* The persona: a monogram on the tenant's soft tint, with a fine inner rule. */}
      <div className="absolute inset-[11%] flex items-center justify-center overflow-hidden rounded-full bg-accent-soft ring-1 ring-inset ring-accent/15">
        <span
          className="relative font-semibold leading-none text-accent"
          style={{ fontSize: 'clamp(1rem, 34cqw, 4.5rem)' }}
        >
          {initial}
        </span>
      </div>

      {/* Status badge on the ring, at the 4:30 position. */}
      {!compact && (
        <span
          className="absolute flex aspect-square w-[22%] items-center justify-center rounded-full border-2 border-card text-white shadow-soft"
          style={{
            right: '6%',
            bottom: '6%',
            background: 'var(--tone)',
            transition: 'background 220ms var(--ease-out)',
          }}
        >
          <Icon
            className={cn(
              'h-1/2 w-1/2',
              mode === 'thinking' && !still && 'motion-safe:animate-spin',
            )}
            strokeWidth={2.4}
          />
        </span>
      )}
    </div>
  );
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
  /** Small inline use: no status badge. */
  compact?: boolean;
}

/**
 * The agent visual. The status caption is real text, so the state is available to screen
 * readers; the avatar itself is decorative.
 */
export function AgentOrb({
  mode,
  level = 0,
  agentName,
  toolLabel,
  className,
  hideCaption,
  compact,
}: AgentOrbProps) {
  const reduced = useReducedMotion();
  const caption = describeAgent(mode, agentName, toolLabel);

  return (
    <div
      className={cn('relative isolate aspect-square w-full', className)}
      style={{ containerType: 'inline-size' }}
    >
      <Avatar mode={mode} name={agentName} level={level} still={reduced} compact={compact} />
      <p
        role="status"
        className={cn(
          'absolute inset-x-0 -bottom-1 mx-auto w-fit max-w-[92%] truncate rounded-full border border-border bg-card px-3 py-1 text-xs font-medium shadow-soft',
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
