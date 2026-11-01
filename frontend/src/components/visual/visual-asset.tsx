import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { visualSrcSet, visualUrl, type VisualKey } from './assets';

export interface VisualAssetProps {
  asset: VisualKey;
  /** Rendered size in CSS pixels. The 96 px file serves up to ~32 px at 3x, the 256 px file the rest. */
  size?: number;
  /** Accessible name. Leave out when the picture only decorates text that is already there. */
  label?: string;
  /** Above-the-fold pictures load at once and first; the rest wait until they scroll near. */
  priority?: boolean;
  /** Load at once without jumping the queue (for pictures that are hidden now but needed instantly). */
  eager?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * A 3D icon as a plain optimised image: no canvas, no script, lazy by default, and sharp on
 * high-density screens because the browser picks the 96 or 256 px file for the size shown.
 * A picture that fails to load leaves its space empty instead of showing a broken-image mark.
 */
export function VisualAsset({
  asset,
  size = 28,
  label,
  priority = false,
  eager = false,
  className,
  style,
}: VisualAssetProps) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, ...style };
  if (failed) return <span aria-hidden="true" className={cn('inline-block shrink-0', className)} style={box} />;
  return (
    <img
      src={visualUrl(asset, size > 48 ? 256 : 96)}
      srcSet={visualSrcSet(asset)}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={label ?? ''}
      decoding="async"
      loading={priority || eager ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      draggable={false}
      onError={() => setFailed(true)}
      className={cn(
        'shrink-0 select-none object-contain',
        // a soft contact shadow only where the picture is big enough to read as an object
        size >= 40 && 'drop-shadow-[0_6px_8px_rgb(0_0_0_/_0.22)]',
        className,
      )}
      style={box}
    />
  );
}
