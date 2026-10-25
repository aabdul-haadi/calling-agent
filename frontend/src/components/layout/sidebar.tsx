import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { ProductMark } from '@/components/brand/marks';
import { useTenant } from '@/context/tenant';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, NAV_ITEMS } from './nav-items';

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
    <nav aria-label="Main" className="space-y-5">
      {NAV_GROUPS.map((group) => (
        <div key={group}>
          <p
            className={cn(
              'mb-1 px-3 text-xs font-medium text-muted-foreground',
              collapsed && 'sr-only',
            )}
          >
            {group}
          </p>
          {collapsed && <div aria-hidden="true" className="mx-3 mb-2 h-px bg-border" />}
          <ul className="space-y-px">
            {NAV_ITEMS.filter((i) => i.group === group).map((item) => {
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
                      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-[1.05rem] w-[1.05rem] shrink-0',
                        active
                          ? 'text-accent'
                          : 'text-muted-foreground group-hover:text-foreground',
                      )}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
                    {count !== undefined && count > 0 && (
                      <span
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-[0.7rem] font-semibold text-card num',
                          collapsed && 'absolute right-1 top-0.5 h-4 min-w-4 px-1',
                        )}
                      >
                        {count}
                        <span className="sr-only"> waiting</span>
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
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
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-300 ease-out lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center gap-3 px-4', collapsed && 'justify-center px-0')}>
        <ProductMark />
        <div className={cn('min-w-0 leading-tight', collapsed && 'sr-only')}>
          <p className="truncate text-sm font-semibold">Agent Delivery Kit</p>
          <p className="truncate text-xs text-muted-foreground">Customer care operations</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <NavList collapsed={collapsed} badges={badges} />
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'm-3 flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
          collapsed && 'justify-center px-0',
        )}
      >
        {collapsed ? (
          <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <>
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Collapse
          </>
        )}
      </button>
    </aside>
  );
}
