import { lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AuthProvider, useAuth } from '@/auth/context';
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

function StatusPage({
  title,
  message,
  action,
  children,
}: {
  title: string;
  message: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
      <p className="eyebrow">Agent Delivery Kit</p>
      <h1 className="mt-2 text-display">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      {children && <p role="alert" className="mt-2 text-sm text-danger">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </main>
  );
}

function AuthCallback() {
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const processed = useRef(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;
    void completeSignIn()
      .then(() => navigate('/', { replace: true }))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Sign-in could not be completed.'),
      );
  }, [completeSignIn, navigate]);

  return (
    <StatusPage
      title={error ? 'Sign-in failed' : 'Finishing sign-in'}
      message={error ?? 'Verifying your account with your identity provider.'}
      action={error ? <a href="/" className="text-sm text-accent underline">Return to sign in</a> : undefined}
    />
  );
}

function SignInPage() {
  const { configured, ready, error, refresh, signIn } = useAuth();
  const [signInError, setSignInError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const startSignIn = async () => {
    setBusy(true);
    setSignInError(undefined);
    try {
      await signIn();
    } catch (reason) {
      setSignInError(reason instanceof Error ? reason.message : 'Could not start sign-in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <StatusPage
      title="Sign in to your workspace"
      message={
        error ??
        'Use your organization account to access the support and AI operations workspaces.'
      }
      action={
        ready ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void startSignIn()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-60"
          >
            {busy ? 'Connecting…' : 'Continue with organization sign-in'}
          </button>
        ) : error ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium"
          >
            Try again
          </button>
        ) : configured ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium"
          >
            Check sign-in configuration
          </button>
        ) : undefined
      }
    >
      {signInError}
    </StatusPage>
  );
}

function GuardedPage({ permission, children }: { permission: string; children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile?.permissions.includes(permission))
    return (
      <StatusPage
        title="Workspace access restricted"
        message="Your account does not have permission to open this workspace. Contact your administrator if you need access."
      />
    );
  return children;
}

function WorkspaceRoutes() {
  return (
    <TenantProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<GuardedPage permission="platform:read"><OverviewPage /></GuardedPage>} />
          <Route path="agent" element={<GuardedPage permission="support:operate"><AgentConsolePage /></GuardedPage>} />
          <Route path="agent/:clientId" element={<GuardedPage permission="support:operate"><AgentConsolePage /></GuardedPage>} />
          <Route path="conversations" element={<GuardedPage permission="support:read"><ConversationsPage /></GuardedPage>} />
          <Route path="traces" element={<GuardedPage permission="diagnostics:read"><TracesPage /></GuardedPage>} />
          <Route path="handoffs" element={<GuardedPage permission="support:handoff"><HandoffsPage /></GuardedPage>} />
          <Route path="inbox" element={<Navigate to="/handoffs" replace />} />
          <Route path="evaluations" element={<GuardedPage permission="evaluations:read"><EvaluationsPage /></GuardedPage>} />
          <Route path="tests" element={<Navigate to="/evaluations" replace />} />
          <Route path="knowledge" element={<GuardedPage permission="knowledge:read"><KnowledgePage /></GuardedPage>} />
          <Route path="learning" element={<GuardedPage permission="learning:read"><LearningPage /></GuardedPage>} />
          <Route path="models" element={<GuardedPage permission="releases:read"><ModelsReleasesPage /></GuardedPage>} />
          <Route path="tenants" element={<GuardedPage permission="ai:configure"><TenantsPage /></GuardedPage>} />
          <Route path="tenants/:clientId" element={<GuardedPage permission="ai:configure"><TenantsPage /></GuardedPage>} />
          <Route path="settings" element={<Navigate to="/tenants" replace />} />
          <Route path="settings/:clientId" element={<GuardedPage permission="ai:configure"><TenantsPage /></GuardedPage>} />
          <Route path="clients/:clientId" element={<LegacyClient />} />
          <Route path="voice" element={<GuardedPage permission="support:operate"><VoiceLabPage /></GuardedPage>} />
          <Route path="architecture" element={<GuardedPage permission="platform:read"><ArchitecturePage /></GuardedPage>} />
          <Route path="about" element={<Navigate to="/architecture" replace />} />
          <Route
            path="*"
            element={<p className="py-10 text-center text-muted-foreground">Page not found.</p>}
          />
        </Route>
      </Routes>
    </TenantProvider>
  );
}

function AuthenticatedRoutes() {
  const auth = useAuth();
  const { pathname } = useLocation();

  if (pathname === '/auth/callback') return <AuthCallback />;
  if (auth.loading)
    return (
      <StatusPage title="Loading workspace" message="Checking your sign-in and workspace permissions." />
    );
  if (auth.error || (auth.configured && !auth.profile)) return <SignInPage />;
  if (!auth.profile)
    return (
      <StatusPage
        title="Sign-in unavailable"
        message="The server did not provide an authenticated workspace profile."
      />
    );
  return <WorkspaceRoutes />;
}

export const AppRoutes = () => (
  <AuthProvider>
    <AuthenticatedRoutes />
  </AuthProvider>
);

export const App = () => (
  <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>
);
