import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { TenantProvider } from '@/context/tenant';

const AgentConsolePage = lazy(() => import('@/pages/agent-console').then((m) => ({ default: m.AgentConsolePage })));
const ArchitecturePage = lazy(() => import('@/pages/architecture').then((m) => ({ default: m.ArchitecturePage })));
const ConversationsPage = lazy(() => import('@/pages/conversations').then((m) => ({ default: m.ConversationsPage })));
const EvaluationsPage = lazy(() => import('@/pages/evaluations').then((m) => ({ default: m.EvaluationsPage })));
const HandoffsPage = lazy(() => import('@/pages/handoffs').then((m) => ({ default: m.HandoffsPage })));
const KnowledgePage = lazy(() => import('@/pages/knowledge').then((m) => ({ default: m.KnowledgePage })));
const LearningPage = lazy(() => import('@/pages/learning').then((m) => ({ default: m.LearningPage })));
const ModelsReleasesPage = lazy(() => import('@/pages/models-releases').then((m) => ({ default: m.ModelsReleasesPage })));
const OverviewPage = lazy(() => import('@/pages/overview').then((m) => ({ default: m.OverviewPage })));
const TenantsPage = lazy(() => import('@/pages/tenants').then((m) => ({ default: m.TenantsPage })));
const TracesPage = lazy(() => import('@/pages/traces').then((m) => ({ default: m.TracesPage })));
const VoiceLabPage = lazy(() => import('@/pages/voice-lab').then((m) => ({ default: m.VoiceLabPage })));

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
        <Route path="conversations" element={<ConversationsPage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="handoffs" element={<HandoffsPage />} />
        <Route path="inbox" element={<Navigate to="/handoffs" replace />} />
        <Route path="evaluations" element={<EvaluationsPage />} />
        <Route path="tests" element={<Navigate to="/evaluations" replace />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="learning" element={<LearningPage />} />
        <Route path="models" element={<ModelsReleasesPage />} />
        <Route path="tenants" element={<TenantsPage />} />
        <Route path="tenants/:clientId" element={<TenantsPage />} />
        <Route path="settings" element={<Navigate to="/tenants" replace />} />
        <Route path="settings/:clientId" element={<TenantsPage />} />
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
