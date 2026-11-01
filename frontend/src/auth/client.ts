/// <reference types="vite/client" />

import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const authority = import.meta.env.VITE_OIDC_AUTHORITY;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
const scope = import.meta.env.VITE_OIDC_SCOPE || 'openid profile email';

export const oidcConfigured = Boolean(authority && clientId);

export const userManager = oidcConfigured
  ? new UserManager({
      authority,
      client_id: clientId,
      redirect_uri: new URL('/auth/callback', window.location.origin).toString(),
      post_logout_redirect_uri: window.location.origin,
      response_type: 'code',
      scope,
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    })
  : undefined;

export async function getAccessToken(): Promise<string | undefined> {
  const user = await userManager?.getUser();
  return user && !user.expired ? user.access_token : undefined;
}
