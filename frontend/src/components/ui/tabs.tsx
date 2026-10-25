import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

/** Accessible tabs (WAI-ARIA pattern): arrow keys move between tabs, Home/End jump. */
export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, index: number) => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    let next = move === undefined ? undefined : (index + move + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div role="tablist" className="mb-4 flex gap-5 overflow-x-auto border-b border-border">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={value === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={value === t.id ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-0.5 pb-2.5 pt-1 text-sm font-medium transition-colors',
              value === t.id
                ? 'border-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={value !== t.id}
        >
          {value === t.id && t.content}
        </div>
      ))}
    </div>
  );
}
