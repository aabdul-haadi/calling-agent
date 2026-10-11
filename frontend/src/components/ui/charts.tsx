import { useId } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'accent' | 'ok' | 'warn' | 'danger';
const stroke: Record<Tone, string> = {
  accent: 'hsl(var(--accent))',
  ok: 'hsl(var(--ok))',
  warn: 'hsl(var(--warn))',
  danger: 'hsl(var(--danger))',
};
const fillClass: Record<Tone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

/** Line + soft area. Needs at least two points; otherwise it explains why it is empty. */
export function Sparkline({
  values,
  tone = 'accent',
  label,
  className,
  max,
}: {
  values: number[];
  tone?: Tone;
  label: string;
  className?: string;
  /** Fixed top of the scale (e.g. 100 for percentages). Defaults to the data range. */
  max?: number;
}) {
  const id = useId();
  if (values.length < 2) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        Not enough runs yet to draw a trend.
      </p>
    );
  }
  const lo = max === undefined ? Math.min(...values) : 0;
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const W = 100;
  const H = 32;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * W,
    H - 3 - ((v - lo) / span) * (H - 6),
  ]);
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x!.toFixed(2)},${y!.toFixed(2)}`)
    .join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn('h-10 w-full overflow-visible', className)}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={stroke[tone]} stopOpacity="0.28" />
          <stop offset="1" stopColor={stroke[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke[tone]}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill={stroke[tone]} />
    </svg>
  );
}

/** A 270° arc gauge for a ratio. `value` null renders an honest "no data" ring. */
export function Gauge({
  value,
  max,
  label,
  display,
  tone = 'accent',
}: {
  value: number | null;
  max: number;
  label: string;
  display: string;
  tone?: Tone;
}) {
  const R = 38;
  const C = 2 * Math.PI * R;
  const arc = C * 0.75;
  const ratio = value === null || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div className="relative mx-auto h-28 w-28" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-[225deg]">
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${arc} ${C}`}
        />
        {value !== null && (
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={stroke[tone]}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${arc * ratio} ${C}`}
            style={{ transition: 'stroke-dasharray 600ms var(--ease-out)' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold tabular-nums">{display}</span>
      </div>
    </div>
  );
}

export interface BarItem {
  label: string;
  value: number;
  /** Text shown at the right, e.g. "12 calls". */
  detail?: string;
  tone?: Tone;
}

/** Horizontal bars scaled to the largest value. */
export function BarList({ items, ariaLabel }: { items: BarItem[]; ariaLabel: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul aria-label={ariaLabel} className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-mono">{i.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {i.detail ?? i.value}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', fillClass[i.tone ?? 'accent'])}
              style={{
                width: `${(i.value / max) * 100}%`,
                transition: 'width 600ms var(--ease-out)',
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface Segment {
  label: string;
  value: number;
  tone: Tone;
}

/** One bar split into proportional segments, with a legend that carries the numbers. */
export function StackedBar({ segments, ariaLabel }: { segments: Segment[]; ariaLabel: string }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <div>
      <div
        role="img"
        aria-label={ariaLabel}
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
      >
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.label}
                className={fillClass[s.tone]}
                style={{ width: `${(s.value / total) * 100}%` }}
              />
            ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', fillClass[s.tone])} />
            {s.label} <span className="tabular-nums text-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
