import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 rounded-md text-sm font-medium transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-foreground shadow-[0_0_0_1px_hsl(var(--accent)/0.5),0_6px_20px_-6px_hsl(var(--glow)/0.55)] hover:brightness-110',
        outline: 'border border-border bg-card hover:border-accent/50 hover:bg-elevated',
        subtle: 'bg-elevated text-foreground hover:bg-muted',
        ghost: 'hover:bg-elevated',
        danger: 'bg-danger text-background hover:brightness-110',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
