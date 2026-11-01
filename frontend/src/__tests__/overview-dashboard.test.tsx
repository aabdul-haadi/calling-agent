import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/auth/context';
import { useTenant } from '@/context/tenant';
import { OverviewPage } from '@/pages/overview';
import { api } from '@/services/api';
import { clients, overview } from './fixtures';

vi.mock('@/auth/context', () => ({ useAuth: vi.fn() }));
vi.mock('@/context/tenant', () => ({ useTenant: vi.fn() }));
vi.mock('@/avatar/preload', () => ({ preloadAvatar: vi.fn(), preloadWhenIdle: vi.fn() }));
vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  return { ...actual, api: { overview: vi.fn(), voiceStatus: vi.fn() } };
});

const mocked = vi.mocked(api);

function setup(permissions: string[], voiceAvailable = true, data = overview) {
  vi.mocked(useAuth).mockReturnValue({
    profile: { subject: 'u', roles: [], tenantIds: [], permissions, authentication: 'oidc' },
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useTenant).mockReturnValue({
    clients: [
      clients[0]!,
      { ...clients[1]!, channels: ['chat', 'voice'] },
    ],
    loading: false,
    reload: () => {},
    tenant: clients[0],
    select: vi.fn(),
  });
  mocked.overview.mockResolvedValue(data);
  mocked.voiceStatus.mockResolvedValue({
    configured: true,
    available: voiceAvailable,
    url: 'ws://localhost:8765',
  });
  return render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );
}

const ALL = [
  'platform:read',
  'support:read',
  'support:operate',
  'support:handoff',
  'knowledge:read',
  'evaluations:read',
];

describe('overview dashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leads with what needs attention, using the numbers the backend returned', async () => {
    setup(ALL);
    const section = await screen.findByRole('region', { name: 'Needs attention' });
    const card = (name: RegExp) => within(section).getByRole('link', { name });
    expect(card(/Waiting for a person/)).toHaveTextContent(String(overview.handoffs.pending));
    expect(card(/Waiting for a person/)).toHaveTextContent('Customers waiting');
    expect(card(/Awaiting approval/)).toHaveTextContent(String(overview.conversations.awaitingApproval));
    expect(card(/Conversations/)).toHaveTextContent(String(overview.conversations.total));
    expect(card(/Conversations/)).toHaveTextContent(`${overview.conversations.last24h} in the last 24 hours`);
    expect(card(/Actions taken/)).toHaveTextContent(String(overview.tools.total));
    expect(card(/Actions taken/)).toHaveTextContent(`${overview.tools.failed} failed or blocked`);
  });

  it('does not raise an alarm when nobody is waiting', async () => {
    setup(ALL, true, { ...overview, handoffs: { pending: 0, accepted: 2, resolved: 3 } });
    const section = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(section).getByRole('link', { name: /Waiting for a person/ })).toHaveTextContent('0');
    expect(within(section).queryByText('Customers waiting')).not.toBeInTheDocument();
  });

  it('shows both agents with their real voice-engine status', async () => {
    setup(ALL, true);
    const agents = await screen.findByRole('region', { name: 'Your agents' });
    expect(within(agents).getByRole('heading', { name: 'Ava' })).toBeInTheDocument();
    expect(within(agents).getByRole('heading', { name: 'Nia' })).toBeInTheDocument();
    expect(await within(agents).findAllByText('Voice engine ready')).toHaveLength(2);
  });

  it('reports a stopped voice engine instead of pretending it is fine', async () => {
    setup(ALL, false);
    const agents = await screen.findByRole('region', { name: 'Your agents' });
    expect(await within(agents).findAllByText('Voice engine not running')).toHaveLength(2);
  });

  it('offers a quick action only for what the signed-in person may do', async () => {
    setup(['platform:read', 'support:read']);
    const actions = await screen.findByRole('region', { name: 'What would you like to do?' });
    expect(within(actions).getByRole('link', { name: /View conversations/ })).toBeInTheDocument();
    expect(within(actions).queryByRole('link', { name: /voice session/ })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('link', { name: /Review handoffs/ })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('link', { name: /quality tests/ })).not.toBeInTheDocument();
  });

  it('with every permission, offers the five main actions with the right destinations', async () => {
    setup(ALL);
    const actions = await screen.findByRole('region', { name: 'What would you like to do?' });
    const hrefs = within(actions)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/voice', '/conversations', '/handoffs', '/knowledge', '/evaluations']);
  });

  it('still says plainly that cost and token usage are not recorded', async () => {
    setup(ALL);
    expect(await screen.findAllByText('Not recorded')).not.toHaveLength(0);
    expect(screen.getByText(/not recorded by this system yet/i)).toBeInTheDocument();
  });

  it('names the selected agent in the setup guide', async () => {
    setup(ALL);
    expect(await screen.findByText('Test Ava')).toBeInTheDocument();
  });
});
