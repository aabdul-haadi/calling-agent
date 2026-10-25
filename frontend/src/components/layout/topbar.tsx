import { ChevronDown, Menu, Moon, Search, Sun } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ProductMark, TenantMark } from '@/components/brand/marks';
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
      <ol className="flex items-center gap-2 text-muted-foreground">
        <li>
          <Link to="/" className="hover:text-foreground">
            Operations
          </Link>
        </li>
        {current && current.id !== 'overview' && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-border">
              /
            </span>
            <span aria-current="page" className="truncate font-medium text-foreground">
              {current.label}
            </span>
          </li>
        )}
        {suffix && (current?.id === 'console' || current?.id === 'settings') && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-border">
              /
            </span>
            <span className="truncate">{suffix === tenant?.id ? tenant.displayName : suffix}</span>
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
      className="hidden items-center gap-2 text-xs text-muted-foreground xl:flex"
    >
      <StatusDot tone={health.error ? 'danger' : up ? 'ok' : health.loading ? 'idle' : 'warn'} />
      <span className="font-medium text-foreground">{label}</span>
      <span>with simulated company systems</span>
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
    const section = /^\/(agent|tenants|settings)\//.exec(pathname)?.[1];
    if (section) navigate(`/${section}/${id}`);
  };
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/90 px-3 backdrop-blur-md sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        onClick={onMenu}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Button>
      <Link to="/" aria-label="Agent Delivery Kit home" className="lg:hidden">
        <ProductMark className="h-7 w-7" />
      </Link>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-2">
        <EnvironmentStatus />
        <label className="relative flex h-9 items-center gap-2 rounded-md border border-border bg-card pl-1.5 pr-2 text-sm shadow-soft hover:border-foreground/25 focus-within:ring-2 focus-within:ring-accent">
          <TenantMark id={tenant?.id} initials={tenant?.initials} className="h-6 w-6" />
          <span className="sr-only">Tenant</span>
          <select
            value={tenant?.id ?? ''}
            onChange={(e) => switchTenant(e.target.value)}
            disabled={clients.length === 0}
            className="max-w-[8rem] cursor-pointer appearance-none bg-transparent pr-5 font-medium focus:outline-none sm:max-w-none"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </label>
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search pages and tenants (Ctrl+K)"
          className="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm text-muted-foreground shadow-soft hover:border-foreground/25 hover:text-foreground md:w-56"
        >
          <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden md:inline">Search…</span>
          <kbd className="ml-auto hidden rounded border border-border bg-muted px-1.5 text-[0.7rem] font-medium md:inline">
            Ctrl K
          </kbd>
        </button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <Sun className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Moon className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} aria-hidden="true" />
          )}
        </Button>
      </div>
    </header>
  );
}
