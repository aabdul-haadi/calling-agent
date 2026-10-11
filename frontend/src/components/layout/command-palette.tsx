import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '@/components/ui/dialog';
import { useTenant } from '@/context/tenant';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-items';

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/** Ctrl/Cmd+K: jump to a page or switch tenant. Only things that really exist are listed. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { clients, tenant, select } = useTenant();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const id = tenant?.id ?? '';
    const pages = NAV_ITEMS.map((n) => ({
      id: `go-${n.id}`,
      label: `Go to ${n.label}`,
      hint: n.hint,
      run: () => navigate(n.to(id)),
    }));
    const tenants = clients.map((c) => ({
      id: `tenant-${c.id}`,
      label: `Switch tenant to ${c.displayName}`,
      hint: c.tagline,
      run: () => select(c.id),
    }));
    return [...pages, ...tenants];
  }, [clients, tenant, navigate, select]);

  const shown = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase().trim()));
  const index = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setQuery('');
      setActive(0);
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <Dialog open={open} title="Jump to" onClose={onClose}>
      <div className="space-y-2">
        <label className="relative block">
          <span className="sr-only">Search pages and tenants</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(Math.min(index + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(Math.max(index - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(shown[index]);
              }
            }}
            placeholder="Type to search…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[index] ? `cmd-${shown[index]!.id}` : undefined}
            className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm"
          />
        </label>
        <ul
          id="palette-list"
          role="listbox"
          aria-label="Results"
          className="max-h-72 overflow-y-auto"
        >
          {shown.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches.
            </li>
          )}
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm',
                i === index && 'bg-elevated',
              )}
            >
              <span>
                <span className="block">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.hint}</span>
              </span>
              {i === index && (
                <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
