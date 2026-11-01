import type { ReactNode } from 'react';

/**
 * The title block every page starts with: a title and a one-line purpose.
 * `eyebrow` is kept for callers but not shown; the breadcrumb already says where you are.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      data-section={eyebrow}
      className="flex w-full min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3"
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-display">{title}</h1>
        {description && (
          <p className="max-w-2xl break-words text-[0.9375rem] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
