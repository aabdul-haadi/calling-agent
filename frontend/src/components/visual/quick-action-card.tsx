import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { VisualKey } from './assets';
import { VisualAsset } from './visual-asset';

/** A shortcut: the picture, what it does in plain words, and where it goes. */
export function QuickActionCard({
  asset,
  title,
  description,
  to,
  onPreload,
  className,
}: {
  asset: VisualKey;
  title: string;
  description: string;
  to: string;
  /** Called when the pointer or keyboard focus arrives, to warm up what the page will need. */
  onPreload?: () => void;
  className?: string;
}) {
  return (
    <Link
      to={to}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onTouchStart={onPreload}
      className={cn(
        'group flex items-center gap-3 rounded-2xl bg-muted/50 p-3 transition duration-200 ease-out',
        'hover:bg-muted motion-safe:hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
    >
      <VisualAsset
        asset={asset}
        size={40}
        className="transition-transform duration-200 motion-safe:group-hover:scale-110"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}
