import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { TenantProvider } from '@/context/tenant';
import { AgentConsolePage } from '@/pages/agent-console';
import { ArchitecturePage } from '@/pages/architecture';
import { EvaluationsPage } from '@/pages/evaluations';
import { HandoffsPage } from '@/pages/handoffs';
import { KnowledgePage } from '@/pages/knowledge';
import { OverviewPage } from '@/pages/overview';
import { TenantsPage } from '@/pages/tenants';
import { TracesPage } from '@/pages/traces';
import { VoiceLabPage } from '@/pages/voice-lab';

/** Old URLs keep working: /clients/:id is now /tenants/:id. */
function LegacyClient() {
  const { clientId = '' } = useParams();
  return <Navigate to={`/tenants/${clientId}`} replace />;
}

export const AppRoutes = () => (
  <TenantProvider>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="agent" element={<AgentConsolePage />} />
        <Route path="agent/:clientId" element={<AgentConsolePage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="handoffs" element={<HandoffsPage />} />
        <Route path="inbox" element={<Navigate to="/handoffs" replace />} />
        <Route path="evaluations" element={<EvaluationsPage />} />
        <Route path="tests" element={<Navigate to="/evaluations" replace />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="tenants" element={<TenantsPage />} />
        <Route path="tenants/:clientId" element={<TenantsPage />} />
        <Route path="clients/:clientId" element={<LegacyClient />} />
        <Route path="voice" element={<VoiceLabPage />} />
        <Route path="architecture" element={<ArchitecturePage />} />
        <Route path="about" element={<Navigate to="/architecture" replace />} />
        <Route
          path="*"
          element={<p className="py-10 text-center text-muted-foreground">Page not found.</p>}
        />
      </Route>
    </Routes>
  </TenantProvider>
);

export const App = () => (
  <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>
);
