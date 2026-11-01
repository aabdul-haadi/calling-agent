import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { ProductMark } from '@/components/brand/marks';
import { VisualAsset } from '@/components/visual/visual-asset';
import { preloadAvatar } from '@/avatar/preload';
import { useAuth } from '@/auth/context';
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
  dark = false,
}: {
  collapsed?: boolean;
  badges?: SidebarBadges;
  onNavigate?: () => void;
  dark?: boolean;
}) {
  const { pathname } = useLocation();
  const { tenant } = useTenant();
  const { profile } = useAuth();
  const id = tenant?.id ?? 'skylink-air';
  const visibleItems = NAV_ITEMS.filter((item) =>
    profile?.permissions.includes(item.permission),
  );
  return (
    <nav aria-label="Main" className="space-y-5">
      {NAV_GROUPS.filter((group) => visibleItems.some((item) => item.group === group)).map((group) => (
        <div key={group}>
          <p
            className={cn(
              'mb-1 px-3 text-xs font-medium text-muted-foreground',
              dark && 'text-slate-400',
              collapsed && 'sr-only',
            )}
          >
            {group}
          </p>
          {collapsed && (
            <div
              aria-hidden="true"
              className={cn('mx-3 mb-2 h-px bg-border', dark && 'bg-slate-700')}
            />
          )}
          <ul className="space-y-px">
            {visibleItems.filter((i) => i.group === group).map((item) => {
              const active = item.match(pathname);
              const count = item.id === 'handoffs' ? badges?.handoffs : undefined;
              const needsAgent = item.id === 'voice' || item.id === 'console';
              return (
                <li key={item.id}>
                  <NavLink
                    to={item.to(id)}
                    onClick={onNavigate}
                    // pages with the 3D agent start fetching it as soon as someone reaches for the link
                    onPointerEnter={needsAgent ? () => preloadAvatar(id) : undefined}
                    onFocus={needsAgent ? () => preloadAvatar(id) : undefined}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                      collapsed && 'justify-center px-0',
                      active
                        ? dark
                          ? 'bg-slate-800 font-medium text-white before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sky-300'
                          : 'bg-accent-soft font-medium text-accent'
                        : dark
                          ? 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                          : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <VisualAsset
                      asset={item.asset}
                      size={24}
                      eager
                      className={cn(
                        'transition duration-200',
                        active
                          ? 'scale-110 opacity-100'
                          : 'opacity-80 group-hover:scale-105 group-hover:opacity-100',
                      )}
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
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-100 transition-[width] duration-300 ease-out lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center gap-3 px-4', collapsed && 'justify-center px-0')}>
        <ProductMark className="shrink-0" />
        <div className={cn('min-w-0 leading-tight', collapsed && 'sr-only')}>
          <p className="truncate text-sm font-semibold text-white">Agent Delivery Kit</p>
          <p className="truncate text-xs text-slate-400">AI operations</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <NavList collapsed={collapsed} badges={badges} dark />
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'm-3 flex h-9 items-center gap-2 rounded-md px-3 text-sm text-slate-400 hover:bg-slate-800 hover:text-white',
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
