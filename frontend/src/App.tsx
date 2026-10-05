import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { AgentConsolePage } from '@/pages/agent-console';
import { ClientConfigPage } from '@/pages/client-config';
import { HandoffInboxPage } from '@/pages/handoff-inbox';
import { HomePage } from '@/pages/home';
import { TestDashboardPage } from '@/pages/test-dashboard';

export const AppRoutes = () => (
  <Routes>
    <Route element={<AppShell />}>
      <Route index element={<HomePage />} />
      <Route path="agent/:clientId" element={<AgentConsolePage />} />
      <Route path="clients/:clientId" element={<ClientConfigPage />} />
      <Route path="inbox" element={<HandoffInboxPage />} />
      <Route path="tests" element={<TestDashboardPage />} />
      <Route path="*" element={<p className="py-10 text-center text-muted-foreground">Page not found.</p>} />
    </Route>
  </Routes>
);

export const App = () => (
  <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>
);
