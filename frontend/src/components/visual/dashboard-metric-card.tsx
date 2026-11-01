import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { VisualKey } from './assets';
import { VisualAsset } from './visual-asset';

/**
 * One number that answers one question, with the picture that says what it is about. `value` null
 * means the system does not record it, and the card says so rather than inventing a figure. A card
 * with `to` is a link to where the number can be acted on.
 */
export function DashboardMetricCard({
  asset,
  label,
  value,
  hint,
  tone,
  attention,
  to,
  onPreload,
}: {
  asset: VisualKey;
  label: string;
  value: ReactNode | null;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
  /** Short words shown when this number needs someone to act. */
  attention?: string;
  to?: string;
  onPreload?: () => void;
}) {
  const body = (
    <>
      <VisualAsset asset={asset} size={48} priority />
      <div className="min-w-0 flex-1">
        <p className="eyebrow">{label}</p>
        <p
          className={cn(
            'mt-1 text-[1.75rem] font-semibold leading-none num',
            tone === 'ok' && 'text-ok',
            tone === 'warn' && 'text-warn',
            tone === 'danger' && 'text-danger',
            value === null && 'text-base font-normal text-muted-foreground',
          )}
        >
          {value ?? 'Not recorded'}
        </p>
        {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
        {attention && (
          <p className="mt-2 inline-block rounded-full bg-warn/15 px-2 py-0.5 text-[0.7rem] font-semibold text-warn">
            {attention}
          </p>
        )}
      </div>
    </>
  );
  const shell = cn(
    'group relative flex h-full flex-col items-start gap-3 rounded-2xl border border-border/60 bg-card p-4 shadow-soft sm:flex-row sm:gap-4',
    'transition duration-200 ease-out motion-safe:hover:-translate-y-0.5 hover:shadow-lg',
  );
  return to ? (
    <Link
      to={to}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      className={cn(shell, 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent')}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
