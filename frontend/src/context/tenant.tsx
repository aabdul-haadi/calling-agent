import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClientSummary } from '@adk/shared';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';

interface TenantContextValue {
  clients: ClientSummary[];
  loading: boolean;
  error?: string;
  reload: () => void;
  /** The tenant every page is scoped to. */
  tenant?: ClientSummary;
  select: (id: string) => void;
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined);
const KEY = 'adk-tenant';

function savedTenant(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Loads the tenant list once and remembers the selection. Pages read it with useTenant(). */
export function TenantProvider({ children }: { children: ReactNode }) {
  const clients = useAsync(() => api.clients());
  const [chosen, setChosen] = useState<string | undefined>(savedTenant);

  const select = useCallback((id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // storage can be blocked; the choice just won't survive a reload
    }
  }, []);

  const value = useMemo<TenantContextValue>(() => {
    const list = clients.data ?? [];
    return {
      clients: list,
      loading: clients.loading,
      error: clients.error,
      reload: clients.reload,
      tenant: list.find((c) => c.id === chosen) ?? list[0],
      select,
    };
  }, [clients.data, clients.loading, clients.error, clients.reload, chosen, select]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used inside <TenantProvider>');
  return ctx;
}
