import { Menu, Moon, Search, Sun } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/stat';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';
import { NAV_ITEMS } from './nav-items';

/** "Operations / Traces": where you are, derived from the route. */
function Breadcrumbs() {
  const { pathname } = useLocation();
  const { tenant } = useTenant();
  const current = NAV_ITEMS.find((n) => n.match(pathname));
  const suffix = pathname.split('/')[2];
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 text-sm sm:block">
      <ol className="flex items-center gap-1.5 text-muted-foreground">
        <li>
          <Link to="/" className="hover:text-foreground">
            Operations
          </Link>
        </li>
        {current && current.id !== 'overview' && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="truncate font-medium text-foreground">
              {current.label}
            </span>
          </li>
        )}
        {suffix && (current?.id === 'console' || current?.id === 'tenants') && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            <span className="truncate font-mono text-xs">
              {suffix === tenant?.id ? tenant.displayName : suffix}
            </span>
          </li>
        )}
      </ol>
    </nav>
  );
}

/** Real status from /health. "Simulated" is stated because the company systems are mocks. */
function EnvironmentStatus() {
  const health = useAsync(() => api.health(), [], 15_000);
  const up = health.data?.status === 'ok';
  const label = health.loading
    ? 'Checking…'
    : health.error
      ? 'API offline'
      : up
        ? 'API online'
        : 'Degraded';
  return (
    <div
      role="status"
      title="Company systems in this build are simulated (mock APIs)"
      className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs md:flex"
    >
      <StatusDot tone={health.error ? 'danger' : up ? 'ok' : health.loading ? 'idle' : 'warn'} />
      <span>{label}</span>
      <span className="text-muted-foreground">· simulated company systems</span>
    </div>
  );
}

export function Topbar({
  onMenu,
  onSearch,
  theme,
  onToggleTheme,
}: {
  onMenu: () => void;
  onSearch: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const { clients, tenant, select } = useTenant();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // On tenant-specific pages the tenant is part of the URL, so switching tenant changes the URL.
  const switchTenant = (id: string) => {
    select(id);
    const section = /^\/(agent|tenants)\//.exec(pathname)?.[1];
    if (section) navigate(`/${section}/${id}`);
  };
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        onClick={onMenu}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Button>
      <Link to="/" className="text-sm font-semibold tracking-tight lg:hidden">
        ADK
      </Link>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-2">
        <EnvironmentStatus />
        <label className="flex items-center gap-2 text-xs">
          <span className="sr-only sm:not-sr-only sm:text-muted-foreground">Tenant</span>
          <select
            value={tenant?.id ?? ''}
            onChange={(e) => switchTenant(e.target.value)}
            disabled={clients.length === 0}
            className="h-9 max-w-[9.5rem] rounded-md border border-border bg-card px-2 text-sm sm:max-w-none"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={onSearch}
          aria-label="Search pages and tenants (Ctrl+K)"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border px-1 font-mono text-[0.65rem] text-muted-foreground sm:inline">
            Ctrl K
          </kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </header>
  );
}
