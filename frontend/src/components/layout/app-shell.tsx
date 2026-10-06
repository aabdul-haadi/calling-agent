import { Bot, Info, Inbox, Moon, ShieldCheck, Sun } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

const links = [
  { to: '/', label: 'Agents', icon: Bot, end: true },
  { to: '/inbox', label: 'Handoff inbox', icon: Inbox },
  { to: '/tests', label: 'Tests', icon: ShieldCheck },
  { to: '/about', label: 'About', icon: Info },
];

export function AppShell() {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-xl focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <NavLink to="/" className="text-base font-semibold tracking-tight">
            Agent Delivery Kit
          </NavLink>
          <nav aria-label="Main" className="flex items-center gap-1">
            {links.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium hover:bg-muted',
                    isActive && 'bg-muted',
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
                <span className="sr-only sm:hidden">{label}</span>
              </NavLink>
            ))}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
