import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  assertTenantAccess,
  permissionForRequest,
  principalForClaims,
  requestTenantId,
} from '@backend/auth/authorization';
import { HttpError } from '@backend/middleware';

const request = (
  method: string,
  path: string,
  body: unknown = {},
  query: Record<string, unknown> = {},
) => ({ method, path, body, query }) as Request;

describe('authorization claim mapping', () => {
  it('maps known roles to least-privilege permissions and reads nested claim paths', () => {
    const principal = principalForClaims(
      {
        sub: 'operator-1',
        name: 'Support Operator',
        access: { roles: ['support_operator'] },
        company_ids: ['skylink-air'],
      },
      'access.roles',
      'company_ids',
    );

    expect(principal.permissions).toContain('support:operate');
    expect(principal.permissions).toContain('support:handoff');
    expect(principal.permissions).not.toContain('knowledge:manage');
    expect(principal.tenantIds).toEqual(['skylink-air']);
  });

  it('does not allow a non-administrator to request global tenant access with a wildcard claim', () => {
    expect(
      principalForClaims(
        { sub: 'operator-1', roles: ['support_operator'], tenant_ids: ['*'] },
        'roles',
        'tenant_ids',
      ).tenantIds,
    ).toEqual([]);
    expect(
      principalForClaims(
        { sub: 'admin-1', roles: ['administrator'], tenant_ids: ['*'] },
        'roles',
        'tenant_ids',
      ).tenantIds,
    ).toEqual(['*']);
  });

  it('maps protected API operations to the intended permission', () => {
    expect(permissionForRequest(request('POST', '/chat'))).toBe('support:operate');
    expect(permissionForRequest(request('POST', '/handoffs/123/resolve'))).toBe(
      'support:handoff',
    );
    expect(permissionForRequest(request('POST', '/clients/skylink-air/knowledge/documents'))).toBe(
      'knowledge:manage',
    );
    expect(
      permissionForRequest(
        request('POST', '/clients/skylink-air/learning/turns/id/review'),
      ),
    ).toBe('learning:review');
    expect(permissionForRequest(request('GET', '/clients'))).toBe('platform:read');
    expect(permissionForRequest(request('DELETE', '/unmapped'))).toBeUndefined();
  });

  it.each([
    ['GET', '/auth/me', 'auth:read'],
    ['GET', '/clients', 'platform:read'],
    ['GET', '/clients/skylink-air', 'platform:read'],
    ['GET', '/clients/skylink-air/knowledge', 'knowledge:read'],
    ['POST', '/clients/skylink-air/knowledge/documents', 'knowledge:manage'],
    ['GET', '/clients/skylink-air/knowledge/documents/doc-1', 'knowledge:read'],
    ['POST', '/clients/skylink-air/knowledge/documents/doc-1/reindex', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/knowledge/documents/doc-1/retry', 'knowledge:manage'],
    ['DELETE', '/clients/skylink-air/knowledge/documents/doc-1', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/knowledge/search', 'knowledge:read'],
    ['POST', '/feedback', 'learning:feedback'],
    ['POST', '/chat', 'support:operate'],
    ['POST', '/chat/stream', 'support:operate'],
    ['GET', '/overview', 'platform:read'],
    ['GET', '/conversations', 'support:read'],
    ['GET', '/conversations/conv-1', 'support:read'],
    ['DELETE', '/conversations/conv-1', 'support:operate'],
    ['PATCH', '/conversations/conv-1/simulator', 'ai:configure'],
    ['POST', '/conversations/conv-1/voice-latency', 'support:operate'],
    ['GET', '/conversations/conv-1/audit', 'diagnostics:read'],
    ['GET', '/handoffs', 'support:read'],
    ['POST', '/handoffs/handoff-1/accept', 'support:handoff'],
    ['POST', '/handoffs/handoff-1/reply', 'support:handoff'],
    ['POST', '/handoffs/handoff-1/resolve', 'support:handoff'],
    ['GET', '/voice/status', 'support:read'],
    ['POST', '/voice/session', 'support:operate'],
    ['POST', '/tests/run', 'evaluations:run'],
    ['GET', '/tests/runs', 'evaluations:read'],
    ['GET', '/tests/runs/run-1', 'evaluations:read'],
    ['GET', '/clients/skylink-air/learning/overview', 'learning:read'],
    ['GET', '/clients/skylink-air/learning/turns', 'learning:read'],
    ['POST', '/clients/skylink-air/learning/turns/turn-1/review', 'learning:review'],
    ['GET', '/clients/skylink-air/learning/gaps', 'learning:read'],
    ['POST', '/clients/skylink-air/learning/gaps/gap-1/status', 'knowledge:manage'],
    ['GET', '/clients/skylink-air/learning/datasets', 'learning:read'],
    ['POST', '/clients/skylink-air/learning/datasets', 'learning:review'],
    ['GET', '/clients/skylink-air/learning/datasets/ds-1/download', 'learning:read'],
    ['GET', '/clients/skylink-air/learning/releases', 'releases:read'],
    ['POST', '/clients/skylink-air/learning/releases/behavior', 'releases:manage'],
    ['POST', '/clients/skylink-air/learning/releases/retrieval/tune', 'releases:manage'],
    ['POST', '/clients/skylink-air/learning/models/intent/train', 'ai:configure'],
    ['POST', '/clients/skylink-air/learning/releases/rel-1/evaluate', 'evaluations:run'],
    ['POST', '/clients/skylink-air/learning/releases/rel-1/shadow', 'evaluations:run'],
    ['POST', '/clients/skylink-air/learning/releases/rel-1/deploy', 'releases:manage'],
    ['POST', '/clients/skylink-air/learning/releases/rel-1/reject', 'releases:manage'],
    ['POST', '/clients/skylink-air/learning/releases/rollback', 'releases:manage'],
    ['GET', '/clients/skylink-air/learning/jobs', 'learning:read'],
    ['POST', '/clients/skylink-air/learning/cycle', 'learning:review'],
    ['DELETE', '/clients/skylink-air/learning/conversations/conv-1', 'admin:manage'],
    ['GET', '/clients/skylink-air/learning/training/hardware', 'ai:configure'],
    ['GET', '/clients/skylink-air/learning/training/runs', 'ai:configure'],
    ['POST', '/clients/skylink-air/learning/training/runs', 'ai:configure'],
    ['POST', '/clients/skylink-air/learning/training/runs/run-1/cancel', 'ai:configure'],
    ['POST', '/clients/skylink-air/learning/training/runs/run-1/resume', 'ai:configure'],
    ['POST', '/clients/skylink-air/learning/models/rel-1/evaluate', 'evaluations:run'],
    ['POST', '/clients/skylink-air/learning/models/rel-1/shadow', 'evaluations:run'],
    ['GET', '/clients/skylink-air/learning/models/rel-1/shadow', 'releases:read'],
    ['POST', '/clients/skylink-air/learning/models/rel-1/promote', 'releases:manage'],
    ['GET', '/clients/skylink-air/learning/knowledge/gaps/gap-1/diagnosis', 'knowledge:read'],
    ['GET', '/clients/skylink-air/learning/knowledge/proposals', 'knowledge:read'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals/proposal-1/evaluate', 'evaluations:run'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals/proposal-1/approve', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals/proposal-1/reject', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals/proposal-1/deploy', 'knowledge:manage'],
    ['POST', '/clients/skylink-air/learning/knowledge/proposals/proposal-1/rollback', 'knowledge:manage'],
  ] as const)('%s %s requires %s', (method, path, permission) => {
    expect(permissionForRequest(request(method, path))).toBe(permission);
  });

  it('does not authorize unsupported methods on known route paths', () => {
    expect(permissionForRequest(request('GET', '/chat'))).toBeUndefined();
    expect(permissionForRequest(request('GET', '/conversations/conv-1/simulator'))).toBeUndefined();
    expect(permissionForRequest(request('DELETE', '/tests/runs/run-1'))).toBeUndefined();
  });

  it('extracts tenant context and denies cross-tenant access', () => {
    const req = request('POST', '/chat', { clientId: 'novatel' });
    expect(requestTenantId(req)).toBe('novatel');
    expect(() =>
      assertTenantAccess(
        principalForClaims(
          { sub: 'operator-1', roles: ['support_operator'], tenant_ids: ['skylink-air'] },
          'roles',
          'tenant_ids',
        ),
        'novatel',
      ),
    ).toThrowError(HttpError);
  });
});
