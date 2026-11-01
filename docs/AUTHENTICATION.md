# Authentication and workspace roles

The browser uses OpenID Connect Authorization Code flow with PKCE. The API independently validates
the signed bearer access token against the issuer's discovery document and JWKS, and checks its
issuer, audience, expiry and signing algorithm. Hiding a page or navigation item is not an
authorization boundary: each API operation is checked on the server.

## Local development

`AUTH_MODE=development` installs a local administrator principal so the existing local demo and
automated tests work without an identity provider. This mode is for a trusted development machine
only. The backend refuses to start in production unless `AUTH_MODE=oidc`.

## OIDC setup

1. Register a **public SPA** client with your identity provider. Enable Authorization Code with
   PKCE (S256); do not configure a client secret in the browser.
2. Register the redirect URI `https://your-console.example/auth/callback` and a post-logout URI
   `https://your-console.example/`. For local development with OIDC, use
   `http://localhost:5173/auth/callback` and `http://localhost:5173/`.
3. Configure the API resource/audience so the SPA receives a signed JWT access token whose `aud`
   contains the configured API audience.
4. Configure the backend and frontend with the same issuer:

   ```dotenv
   AUTH_MODE=oidc
   OIDC_ISSUER=https://identity.example.com/tenant
   OIDC_AUDIENCE=agent-delivery-api
   OIDC_ROLE_CLAIM=roles
   OIDC_TENANT_CLAIM=tenant_ids

   VITE_OIDC_AUTHORITY=https://identity.example.com/tenant
   VITE_OIDC_CLIENT_ID=agent-delivery-web
   VITE_OIDC_SCOPE=openid profile email
   ```

   Set `VITE_API_URL` and `CORS_ORIGIN` to the actual API and console origins. Frontend `VITE_`
   settings are embedded at build time; rebuild the web app after changing them.
5. Add role and tenant claims to access tokens using the exact values below. The default claim
   paths may be changed to dot-separated paths, for example `access.roles` or `company_ids`.
6. Require HTTPS for the issuer in production. Keep the API reachable only through trusted network
   paths, and use an encrypted database and TLS for database connections.

The API metadata at `GET /auth/config` is public and contains only the auth mode and issuer.
`GET /auth/me` returns the verified subject, assigned role names, authorized tenant IDs and
effective permissions. The browser keeps OIDC state in session storage and does not persist tokens
in local storage.

## Built-in roles

Assign one or more of these role claim values. Unknown role strings grant no permissions.

| Claim value | Intended workspace access |
| --- | --- |
| `support_operator` | Support conversations and handoffs; no knowledge publishing or release actions |
| `knowledge_manager` | Read and manage policy documents, knowledge gaps and knowledge proposals |
| `ai_engineer` | AI configuration, diagnostics, evaluations, knowledge read, and release management |
| `evaluator` | Learning review, evaluations and candidate release read access |
| `administrator` | All application permissions |

The tenant claim must be an array of the application's configured client IDs, such as
`["skylink-air"]`; it may also be a single string for one tenant. Ordinary roles cannot gain
cross-tenant access by including `"*"` in a claim. A signed `administrator` role can be issued `"*"`
for an explicitly global administrator, or specific tenant IDs for a tenant-scoped administrator.
Grant these IdP assignments only through your organization's approval process.

## Protected API behavior

- Every API other than `GET /health` and `GET /auth/config` requires a verified identity.
- Each operation has a server-side permission requirement. Tenant-scoped URLs, request bodies and
  query filters are checked against the verified tenant claim. Conversation and handoff IDs are
  also checked against their stored tenant before reading or mutating them.
- Customer feedback uses its own `learning:feedback` permission. A learning-review identity is
  derived from the verified subject/name, not from a caller-supplied reviewer name.
- The voice gateway is a service client, not an operator login. It can submit turns only to the
  chat endpoints using the shared `VOICE_GATEWAY_SECRET`; the secret is not accepted for other
  routes. The gateway must use the same secret as the backend.
- `LEARNING_REVIEW_TOKEN` is obsolete and is no longer an authorization mechanism. Rotate/remove
  any old token and use OIDC roles instead.

These roles and their permission mapping are intentionally fixed in backend code for now; this
version does not provide in-product user, role or tenant administration. Assignments are managed
in the identity provider.
