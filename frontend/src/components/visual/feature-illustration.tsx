import { cn } from '@/lib/utils';
import type { VisualKey } from './assets';
import { VisualAsset } from './visual-asset';

type Tone = 'accent' | 'ok' | 'warn' | 'danger';

const GLOW: Record<Tone, string> = {
  accent: 'bg-accent/15',
  ok: 'bg-ok/15',
  warn: 'bg-warn/20',
  danger: 'bg-danger/15',
};

/**
 * A larger 3D picture on a soft round glow. It adds hierarchy to a card or an empty state without
 * boxing the picture in; the glow follows the meaning (calm, needs attention, problem).
 */
export function FeatureIllustration({
  asset,
  size = 88,
  tone = 'accent',
  label,
  priority,
  className,
}: {
  asset: VisualKey;
  size?: number;
  tone?: Tone;
  label?: string;
  priority?: boolean;
  className?: string;
}) {
  const glow = Math.round(size * 1.35);
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: glow, height: glow }}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-0 rounded-full blur-xl', GLOW[tone])}
      />
      <VisualAsset asset={asset} size={size} label={label} priority={priority} className="relative" />
    </span>
  );
}
