import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Placeholder block shown while data loads. Hidden from screen readers; the parent announces loading. */
export const Skeleton = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    aria-hidden="true"
    className={cn('animate-pulse rounded-xl bg-muted', className)}
    {...props}
  />
);
