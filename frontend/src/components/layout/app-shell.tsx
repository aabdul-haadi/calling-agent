import { useEffect, useState } from 'react';
import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Dialog } from '@/components/ui/dialog';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/services/api';
import { CommandPalette } from './command-palette';
import { NavList, Sidebar } from './sidebar';
import { Topbar } from './topbar';

const COLLAPSE_KEY = 'adk-sidebar-collapsed';

function savedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppShell() {
  const { theme, toggle } = useTheme();
  const { tenant } = useTenant();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  // Badge on "Human Handoffs": the real number waiting for a person.
  const overview = useAsync(() => api.overview(), [], 10_000);
  const badges = { handoffs: overview.data?.handoffs.pending };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        // ignore blocked storage
      }
      return !c;
    });

  return (
    <div data-accent={tenant?.accent} className="flex min-h-screen">
      <div className="backdrop" aria-hidden="true" />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} badges={badges} />

      <Dialog open={drawer} title="Navigation" placement="left" onClose={() => setDrawer(false)}>
        <NavList badges={badges} onNavigate={() => setDrawer(false)} />
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onMenu={() => setDrawer(true)}
          onSearch={() => setPalette(true)}
          theme={theme}
          onToggleTheme={toggle}
        />
        <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <div key={pathname} className="page-enter">
            <Suspense fallback={<div role="status" aria-label="Loading page" className="h-40 animate-pulse rounded-lg bg-elevated" />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
