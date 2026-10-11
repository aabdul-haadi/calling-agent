import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** The base surface. Raised one step above the page, with a fine border and a faint top highlight. */
export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('rounded-lg border border-border bg-card shadow-soft', className)}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex items-center justify-between gap-2 px-4 pt-3.5', className)}
    {...props}
  />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('eyebrow', className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-4 pb-4 pt-3', className)} {...props} />
);
