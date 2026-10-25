import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: focus moves in, Tab stays inside, Escape closes, focus returns to the opener.
 * Not a native <dialog> so it behaves the same in every browser and in tests.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  placement = 'center',
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  placement?: 'center' | 'left';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex p-0',
        placement === 'left' ? 'justify-start' : 'items-end justify-center sm:items-center sm:p-4',
      )}
    >
      <div
        className="absolute inset-0 bg-[hsl(216_50%_8%/0.45)]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'page-enter relative border border-border bg-card p-5 shadow-raised',
          placement === 'left'
            ? 'h-full w-72 max-w-[85vw] overflow-y-auto rounded-none border-y-0 border-l-0'
            : 'w-full max-w-md rounded-t-lg sm:rounded-lg',
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
