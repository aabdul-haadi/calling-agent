import type { Request } from 'express';
import { HttpError } from '../middleware';

export type Permission =
  | 'admin:manage'
  | 'ai:configure'
  | 'auth:read'
  | 'diagnostics:read'
  | 'evaluations:read'
  | 'evaluations:run'
  | 'knowledge:manage'
  | 'knowledge:read'
  | 'learning:feedback'
  | 'learning:read'
  | 'learning:review'
  | 'platform:read'
  | 'releases:manage'
  | 'releases:read'
  | 'support:handoff'
  | 'support:operate'
  | 'support:read';

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  support_operator: [
    'platform:read',
    'auth:read',
    'support:read',
    'support:operate',
    'support:handoff',
    'learning:feedback',
  ],
  knowledge_manager: [
    'platform:read',
    'auth:read',
    'knowledge:read',
    'knowledge:manage',
  ],
  ai_engineer: [
    'platform:read',
    'auth:read',
    'ai:configure',
    'diagnostics:read',
    'evaluations:read',
    'evaluations:run',
    'knowledge:read',
    'releases:read',
    'releases:manage',
    'support:read',
  ],
  evaluator: [
    'platform:read',
    'auth:read',
    'evaluations:read',
    'evaluations:run',
    'learning:read',
    'learning:review',
    'releases:read',
  ],
  administrator: [
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
};

export interface Principal {
  sub: string;
  name?: string;
  email?: string;
  roles: string[];
  tenantIds: string[];
  permissions: Permission[];
  service?: 'voice-gateway';
}

declare global {
  // Express request augmentation is the framework-supported way to expose verified identity.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export function principalForClaims(
  claims: Record<string, unknown>,
  roleClaim: string,
  tenantClaim: string,
): Principal {
  const roles = claimValue(claims, roleClaim);
  const tenantIds = claimValue(claims, tenantClaim);
  const normalizedRoles = Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : typeof roles === 'string'
      ? [roles]
      : [];
  const normalizedTenants = Array.isArray(tenantIds)
    ? tenantIds.filter((tenant): tenant is string => typeof tenant === 'string')
    : typeof tenantIds === 'string'
      ? [tenantIds]
      : [];
  const uniqueRoles = [...new Set(normalizedRoles)];
  const authorizedTenants = uniqueRoles.includes('administrator')
    ? [...new Set(normalizedTenants)]
    : [...new Set(normalizedTenants.filter((tenant) => tenant !== '*'))];
  const permissions = new Set<Permission>();
  for (const role of uniqueRoles)
    for (const permission of ROLE_PERMISSIONS[role] ?? []) permissions.add(permission);

  return {
    sub: typeof claims.sub === 'string' ? claims.sub : '',
    name: typeof claims.name === 'string' ? claims.name : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    roles: uniqueRoles,
    tenantIds: authorizedTenants,
    permissions: [...permissions],
  };
}

function claimValue(claims: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, claims);
}

export function requirePermission(req: Request, permission: Permission): Principal {
  const principal = req.principal;
  if (!principal) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to continue.');
  if (!principal.permissions.includes(permission))
    throw new HttpError(403, 'FORBIDDEN', 'Your role does not allow this action.');
  return principal;
}

export function assertTenantAccess(principal: Principal, tenantId: string): void {
  if (!principal.tenantIds.includes('*') && !principal.tenantIds.includes(tenantId))
    throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
}

function learningPermission(path: string, method: string): Permission | undefined {
  if (path === '/feedback' && method === 'POST') return 'learning:feedback';
  if (!path.includes('/learning/')) return undefined;
  if (method === 'GET') {
    if (/\/(releases|models)(\/|$)/.test(path)) return 'releases:read';
    if (/\/training\/(hardware|runs)/.test(path)) return 'ai:configure';
    if (/\/knowledge\//.test(path)) return 'knowledge:read';
    return 'learning:read';
  }
  if (/\/turns\/[^/]+\/review$/.test(path) && method === 'POST') return 'learning:review';
  if (/\/gaps\/[^/]+\/status$/.test(path) && method === 'POST') return 'knowledge:manage';
  if (/\/knowledge\/gaps\/[^/]+\/diagnosis$/.test(path) && method === 'GET')
    return 'knowledge:read';
  if (/\/knowledge\/proposals\/[^/]+\/evaluate$/.test(path) && method === 'POST')
    return 'evaluations:run';
  if (/\/knowledge\/proposals\/[^/]+\/(approve|reject|deploy|rollback)$/.test(path) && method === 'POST')
    return 'knowledge:manage';
  if (/\/knowledge\/proposals$/.test(path) && method === 'POST') return 'knowledge:manage';
  if (/\/knowledge\/proposals\/[^/]+$/.test(path) && method === 'POST')
    return 'knowledge:manage';
  if (/\/datasets$/.test(path) && method === 'POST') return 'learning:review';
  if (/\/releases\/(behavior|retrieval\/tune|rollback)$/.test(path) && method === 'POST')
    return 'releases:manage';
  if (/\/releases\/[^/]+\/(evaluate|shadow)$/.test(path) && method === 'POST')
    return 'evaluations:run';
  if (/\/releases\/[^/]+\/(deploy|reject)$/.test(path) && method === 'POST')
    return 'releases:manage';
  if (/\/models\/intent\/train$/.test(path) && method === 'POST')
    return 'ai:configure';
  if (/\/models\/[^/]+\/(evaluate|shadow)$/.test(path) && method === 'POST')
    return 'evaluations:run';
  if (/\/models\/.*\/promote$/.test(path) && method === 'POST') return 'releases:manage';
  if (/\/training\//.test(path) && method === 'POST') return 'ai:configure';
  if (/\/cycle$/.test(path) && method === 'POST') return 'learning:review';
  if (/\/conversations\/[^/]+$/.test(path) && method === 'DELETE') return 'admin:manage';
  return undefined;
}

export function permissionForRequest(req: Request): Permission | undefined {
  const { method, path } = req;
  if (path === '/auth/me' && method === 'GET') return 'auth:read';
  if (path === '/clients' && method === 'GET') return 'platform:read';
  if (/^\/clients\/[^/]+$/.test(path) && method === 'GET') return 'platform:read';
  if (/^\/clients\/[^/]+\/knowledge(?:\/|$)/.test(path)) {
    if (method === 'GET' || (method === 'POST' && path.endsWith('/search')))
      return 'knowledge:read';
    return 'knowledge:manage';
  }
  const learningAccess = learningPermission(path, method);
  if (learningAccess) return learningAccess;
  if (path === '/feedback' && method === 'POST') return 'learning:feedback';
  if ((path === '/chat' || path === '/chat/stream') && method === 'POST')
    return 'support:operate';
  if (path === '/overview' && method === 'GET') return 'platform:read';
  if (path === '/conversations' && method === 'GET') return 'support:read';
  if (/^\/conversations\/[^/]+\/audit$/.test(path) && method === 'GET')
    return 'diagnostics:read';
  if (/^\/conversations\/[^/]+$/.test(path) && method === 'GET') return 'support:read';
  if (/^\/conversations\/[^/]+$/.test(path) && method === 'DELETE') return 'support:operate';
  if (/^\/conversations\/[^/]+\/simulator$/.test(path) && method === 'PATCH')
    return 'ai:configure';
  if (/^\/conversations\/[^/]+\/voice-latency$/.test(path) && method === 'POST')
    return 'support:operate';
  if (path === '/handoffs' && method === 'GET') return 'support:read';
  if (path.startsWith('/handoffs/') && method === 'POST') return 'support:handoff';
  if (path === '/voice/status' && method === 'GET') return 'support:read';
  if (path === '/voice/session' && method === 'POST') return 'support:operate';
  if (/^\/tests\/runs(?:\/[^/]+)?$/.test(path) && method === 'GET')
    return 'evaluations:read';
  if (path === '/tests/run' && method === 'POST') return 'evaluations:run';
  return undefined;
}

export function requestTenantId(req: Request): string | undefined {
  const clientPath = /^\/clients\/([^/]+)(?:\/|$)/.exec(req.path)?.[1];
  if (clientPath) return decodeURIComponent(clientPath);
  const bodyId = req.body && typeof req.body.clientId === 'string' ? req.body.clientId : undefined;
  if (bodyId) return bodyId;
  const queryId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  return queryId;
}

export function developmentPrincipal(tenantIds: string[]): Principal {
  return {
    sub: 'local-development',
    name: 'Local development user',
    roles: ['administrator'],
    tenantIds: ['*', ...tenantIds],
    permissions: [...new Set(Object.values(ROLE_PERMISSIONS).flat())],
  };
}
