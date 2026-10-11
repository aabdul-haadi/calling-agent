import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { useTenant } from '@/context/tenant';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-items';

export interface SidebarBadges {
  handoffs?: number;
  approvals?: number;
}

/** The navigation list, shared by the desktop sidebar and the mobile drawer. */
export function NavList({
  collapsed = false,
  badges,
  onNavigate,
}: {
  collapsed?: boolean;
  badges?: SidebarBadges;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const { tenant } = useTenant();
  const id = tenant?.id ?? 'skylink-air';
  return (
    <nav aria-label="Main">
      <ul className="space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname);
          const count = item.id === 'handoffs' ? badges?.handoffs : undefined;
          return (
            <li key={item.id}>
              <NavLink
                to={item.to(id)}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted-foreground hover:bg-elevated hover:text-foreground',
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1.5 h-[calc(100%-0.75rem)] w-0.5 rounded-full bg-accent"
                  />
                )}
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
                {count !== undefined && count > 0 && (
                  <Badge
                    tone="warn"
                    className={cn('ml-auto', collapsed && 'absolute right-1 top-0.5 px-1')}
                  >
                    {count}
                    <span className="sr-only"> waiting</span>
                  </Badge>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  badges,
}: {
  collapsed: boolean;
  onToggle: () => void;
  badges?: SidebarBadges;
}) {
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card/60 backdrop-blur transition-[width] duration-300 ease-out lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-60',
      )}
    >
      <div
        className={cn('flex h-14 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-mono text-xs font-bold text-accent-foreground shadow-glow"
        >
          A
        </span>
        <span className={cn('text-sm font-semibold tracking-tight', collapsed && 'sr-only')}>
          Agent Delivery Kit
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <NavList collapsed={collapsed} badges={badges} />
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex h-11 items-center justify-center gap-2 border-t border-border text-xs text-muted-foreground hover:bg-elevated hover:text-foreground"
      >
        {collapsed ? (
          <ChevronsRight className="h-4 w-4" aria-hidden="true" />
        ) : (
          <>
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" /> Collapse
          </>
        )}
      </button>
    </aside>
  );
}
