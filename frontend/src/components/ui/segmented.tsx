import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** A radio-group styled as a pill switch: filters, view modes. Arrow keys move between options. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex max-w-full overflow-x-auto rounded-md bg-muted p-0.5"
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = options[(i + step + options.length) % options.length]!;
              onChange(next.value);
              (
                e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement
              )?.focus();
            }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-[0.3rem] px-3 py-1.5 text-[0.8125rem] font-medium transition-colors',
              on
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn('tabular-nums', on ? 'opacity-80' : 'opacity-60')}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
