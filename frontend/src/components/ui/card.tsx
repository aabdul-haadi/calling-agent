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
    className={cn(
      'flex min-h-[3.25rem] items-center justify-between gap-2 border-b border-border px-5 py-3',
      className,
    )}
    {...props}
  />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('panel-title', className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 pb-5 pt-4', className)} {...props} />
);
