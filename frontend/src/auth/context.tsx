import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, type AuthConfig, type AuthProfile } from '@/services/api';
import { oidcConfigured, userManager } from './client';

const DEV_PROFILE: AuthProfile = {
  subject: 'local-development',
  name: 'Local development user',
  roles: ['administrator'],
  tenantIds: [],
  permissions: [
    'admin:manage',
    'ai:configure',
    'auth:read',
    'diagnostics:read',
    'evaluations:read',
    'evaluations:run',
    'knowledge:manage',
    'knowledge:read',
    'learning:feedback',
    'learning:read',
    'learning:review',
    'platform:read',
    'releases:manage',
    'releases:read',
    'support:handoff',
    'support:operate',
    'support:read',
  ],
  authentication: 'development',
};

interface AuthContextValue {
  configured: boolean;
  ready: boolean;
  loading: boolean;
  profile?: AuthProfile;
  error?: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  completeSignIn: () => Promise<void>;
}

const fallbackAuth: AuthContextValue = {
  configured: false,
  ready: false,
  loading: false,
  profile: DEV_PROFILE,
  signIn: async () => {},
  signOut: async () => {},
  refresh: async () => {},
  completeSignIn: async () => {},
};

const AuthContext = createContext<AuthContextValue>(fallbackAuth);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig>();
  const [profile, setProfile] = useState<AuthProfile>();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setReady(false);
    setError(undefined);
    try {
      const currentConfig = await api.authConfig();
      setConfig(currentConfig);
      if (currentConfig.mode === 'development') {
        setReady(false);
        setProfile(DEV_PROFILE);
        return;
      }
      if (!oidcConfigured || !userManager) {
        setReady(false);
        setProfile(undefined);
        setError(
          'This server requires OIDC sign-in. Configure VITE_OIDC_AUTHORITY and VITE_OIDC_CLIENT_ID for the web app.',
        );
        return;
      }
      const configuredAuthority = new URL(import.meta.env.VITE_OIDC_AUTHORITY).toString().replace(/\/$/, '');
      const serverAuthority = new URL(currentConfig.issuer ?? '').toString().replace(/\/$/, '');
      if (configuredAuthority !== serverAuthority) {
        setReady(false);
        setProfile(undefined);
        setError('The web app identity provider does not match the backend OIDC issuer.');
        return;
      }
      setReady(true);
      const user = await userManager.getUser();
      if (!user || user.expired) {
        setProfile(undefined);
        return;
      }
      setProfile(await api.authMe());
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'UNAUTHORIZED') {
        await userManager?.removeUser();
        setProfile(undefined);
        setError(undefined);
      } else {
        setProfile(undefined);
        setError(reason instanceof Error ? reason.message : 'Could not verify your account.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const manager = userManager;
    if (!manager)
      return () => window.clearTimeout(timer);
    const onUserChanged = () => void refresh();
    manager.events.addUserLoaded(onUserChanged);
    manager.events.addUserUnloaded(onUserChanged);
    return () => {
      window.clearTimeout(timer);
      manager.events.removeUserLoaded(onUserChanged);
      manager.events.removeUserUnloaded(onUserChanged);
    };
  }, [refresh]);

  const signIn = useCallback(async () => {
    if (!userManager) return;
    await userManager.signinRedirect();
  }, []);

  const signOut = useCallback(async () => {
    if (!userManager) return;
    setProfile(undefined);
    await userManager.signoutRedirect();
  }, []);

  const completeSignIn = useCallback(async () => {
    if (!userManager) throw new Error('OIDC sign-in is not configured.');
    await userManager.signinRedirectCallback();
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      configured: config?.mode === 'oidc',
      ready,
      loading,
      profile,
      error,
      signIn,
      signOut,
      refresh,
      completeSignIn,
    }),
    [config, ready, loading, profile, error, signIn, signOut, refresh, completeSignIn],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
