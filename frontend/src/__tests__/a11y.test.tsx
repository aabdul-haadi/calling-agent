import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/App';
import { api } from '@/services/api';
import { clientDetail, clients, handoff, run } from './fixtures';

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  return {
    ...actual,
    api: {
      health: vi.fn(),
      clients: vi.fn(),
      client: vi.fn(),
      chat: vi.fn(),
      conversation: vi.fn(),
      resetConversation: vi.fn(),
      setSimulator: vi.fn(),
      voiceLatency: vi.fn(),
      handoffs: vi.fn(),
      acceptHandoff: vi.fn(),
      startRun: vi.fn(),
      runs: vi.fn(),
      run: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.handoffs.mockResolvedValue([handoff]);
  mocked.runs.mockResolvedValue([run]);
  mocked.chat.mockResolvedValue({
    conversationId: 'c1',
    reply: 'Happy to help. What is your booking reference?',
    state: { verified: false, journeyId: 'rebooking', journeyStep: 'identify_intent', collected: {}, handedOff: false },
    trace: [{ id: 't1', at: '2026-11-10T10:00:00.000Z', type: 'intent', label: 'Understood intent: rebooking', status: 'ok', detail: { intent: 'rebooking' } }],
    citations: [{ source: 'checked-baggage', heading: 'Checked baggage', snippet: 'One bag free in Economy.', score: 0.8 }],
  });
});

/** Serious/critical axe violations fail the test. (Colour contrast is checked separately in contrast.test.ts, jsdom cannot.) */
async function expectNoSeriousA11yIssues(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('accessibility (axe)', () => {
  it('home / client picker', async () => {
    const { container } = renderAt('/');
    await screen.findByText('NovaTel');
    await expectNoSeriousA11yIssues(container);
  });

  it('agent console (chat + trace + state)', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/agent/skylink-air');
    await screen.findByText(/Hi, I'm Ava/);
    await user.click(screen.getByRole('button', { name: 'My flight was cancelled' }));
    await screen.findByText(/Happy to help/);
    await expectNoSeriousA11yIssues(container);
  });

  it('handoff inbox', async () => {
    const { container } = renderAt('/inbox');
    await screen.findByText('Customer asked for a human');
    await expectNoSeriousA11yIssues(container);
  });

  it('test dashboard with a failure panel open', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/tests');
    await user.click(await screen.findByRole('button', { name: /Prompt injection/ }));
    await screen.findByText('Expected behaviour');
    await expectNoSeriousA11yIssues(container);
  });

  it('client config viewer', async () => {
    const { container } = renderAt('/clients/skylink-air');
    await screen.findByText(/SkyLink Air configuration/);
    await expectNoSeriousA11yIssues(container);
  });

  it('error state is announced with role=alert and offers a retry', async () => {
    mocked.clients.mockRejectedValueOnce(new Error("Can't reach the server. Is the backend running?"));
    renderAt('/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't reach the server");
    mocked.clients.mockResolvedValue(clients);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('NovaTel')).toBeInTheDocument());
  });
});
