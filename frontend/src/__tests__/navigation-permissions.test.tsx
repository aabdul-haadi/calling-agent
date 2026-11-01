import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/auth/context';
import { useTenant } from '@/context/tenant';
import { NavList } from '@/components/layout/sidebar';
import { clients } from './fixtures';

vi.mock('@/auth/context', () => ({ useAuth: vi.fn() }));
vi.mock('@/context/tenant', () => ({ useTenant: vi.fn() }));

const permissions = [
  'platform:read',
  'support:read',
  'support:operate',
  'support:handoff',
  'learning:feedback',
];

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    configured: true,
    ready: true,
    loading: false,
    profile: {
      subject: 'support-operator-1',
      roles: ['support_operator'],
      tenantIds: ['skylink-air'],
      permissions,
      authentication: 'oidc',
    },
    signIn: async () => {},
    signOut: async () => {},
    refresh: async () => {},
    completeSignIn: async () => {},
  });
  vi.mocked(useTenant).mockReturnValue({
    clients,
    loading: false,
    reload: () => {},
    tenant: clients[0],
    select: () => {},
  });
});

describe('role-aware navigation', () => {
  it('shows only workspaces allowed by the verified support-operator permissions', () => {
    render(
      <MemoryRouter>
        <NavList />
      </MemoryRouter>,
    );

    const navigation = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(navigation.getByRole('link', { name: 'Support workspace' })).toHaveAttribute(
      'href',
      '/agent/skylink-air',
    );
    expect(navigation.getByRole('link', { name: 'Conversation history' })).toBeInTheDocument();
    expect(navigation.getByRole('link', { name: 'Human handoffs' })).toBeInTheDocument();
    expect(navigation.queryByRole('link', { name: 'Policy documents' })).not.toBeInTheDocument();
    expect(navigation.queryByRole('link', { name: 'Review & improve' })).not.toBeInTheDocument();
    expect(navigation.queryByRole('link', { name: 'Agent evaluations' })).not.toBeInTheDocument();
  });
});
