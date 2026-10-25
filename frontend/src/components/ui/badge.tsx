import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0 text-xs font-medium leading-5',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-foreground/85',
        accent: 'bg-accent-soft text-accent',
        ok: 'bg-ok/10 text-ok',
        warn: 'bg-warn/10 text-warn',
        danger: 'bg-danger/10 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, tone, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ tone }), className)} {...props} />
);
