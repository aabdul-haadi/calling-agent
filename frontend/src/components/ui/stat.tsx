import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A compact metric. `value` null means the system does not record it, and the tile says so
 * instead of showing a made-up number.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: ReactNode | null;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="eyebrow truncate">{label}</dt>
      <dd>
        <span
          className={cn(
            'mt-1.5 block text-[1.75rem] font-semibold leading-none num',
            tone === 'ok' && 'text-ok',
            tone === 'warn' && 'text-warn',
            tone === 'danger' && 'text-danger',
            value === null && 'text-base font-normal text-muted-foreground',
          )}
        >
          {value ?? 'Not recorded'}
        </span>
        {hint && <span className="mt-2 block text-xs text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'idle' }) {
  const color = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    idle: 'bg-muted-foreground',
  }[tone];
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}
