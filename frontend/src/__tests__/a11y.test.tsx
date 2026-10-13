import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@adk/shared';
import { AppRoutes } from '@/App';
import { api } from '@/services/api';
import {
  clientDetail,
  clients,
  conversations,
  conversationView,
  handoff,
  knowledgeDocs,
  overview,
  run,
} from './fixtures';

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
      replyHandoff: vi.fn(),
      resolveHandoff: vi.fn(),
      startRun: vi.fn(),
      runs: vi.fn(),
      run: vi.fn(),
      overview: vi.fn(),
      conversations: vi.fn(),
      audit: vi.fn(),
      knowledge: vi.fn(),
      voiceStatus: vi.fn(),
      voiceSession: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

const reply = (over: Partial<ChatResponse['state']> = {}): ChatResponse => ({
  conversationId: 'c1',
  reply: 'Happy to help. What is your booking reference? [Source: checked-baggage]',
  state: {
    phase: 'VERIFYING',
    verified: false,
    journeyId: 'rebooking',
    journeyStep: 'identify_intent',
    collected: {},
    handedOff: false,
    ...over,
  },
  trace: conversationView.trace.slice(0, 3),
  citations: [
    {
      source: 'checked-baggage',
      heading: 'Checked baggage',
      snippet: 'One bag free in Economy.',
      score: 0.8,
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocked.health.mockResolvedValue({ status: 'ok', db: 'up' });
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.handoffs.mockResolvedValue([handoff]);
  mocked.runs.mockResolvedValue([run]);
  mocked.overview.mockResolvedValue(overview);
  mocked.conversations.mockResolvedValue(conversations);
  mocked.conversation.mockResolvedValue(conversationView);
  mocked.audit.mockResolvedValue([]);
  mocked.knowledge.mockResolvedValue(knowledgeDocs);
  mocked.voiceStatus.mockResolvedValue({ configured: true, available: false, url: '' });
  mocked.chat.mockResolvedValue(reply());
});

/** Serious/critical axe violations fail the test. (Colour contrast is checked separately in contrast.test.ts, jsdom cannot.) */
async function expectNoSeriousA11yIssues(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const serious = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('accessibility (axe)', () => {
  it('overview', async () => {
    const { container } = renderAt('/');
    await screen.findByText('Evaluation quality');
    await expectNoSeriousA11yIssues(container);
  });

  it('agent console (chat, citations, trace, state)', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/agent/skylink-air');
    await screen.findByText(/Hi, I'm Ava/);
    await user.click(screen.getByRole('button', { name: 'My flight was cancelled' }));
    await screen.findByText(/Happy to help/);
    await expectNoSeriousA11yIssues(container);
  });

  it('agent console with an approval waiting', async () => {
    mocked.chat.mockResolvedValue(
      reply({
        phase: 'AWAITING_APPROVAL',
        pendingApproval: {
          summary: 'Move booking SK1001 to flight SK110',
          expiresAt: '2026-11-10T10:10:00.000Z',
        },
      }),
    );
    const user = userEvent.setup();
    const { container } = renderAt('/agent/skylink-air');
    await user.click(await screen.findByRole('button', { name: 'My flight was cancelled' }));
    await screen.findByText('Approve this change?');
    await expectNoSeriousA11yIssues(container);
  });

  it('traces', async () => {
    const { container } = renderAt('/traces');
    await screen.findByText('Understood intent: rebooking');
    await expectNoSeriousA11yIssues(container);
  });

  it('human handoffs', async () => {
    const { container } = renderAt('/handoffs');
    await screen.findAllByText('Customer asked for a human');
    await expectNoSeriousA11yIssues(container);
  });

  it('evaluations with a failure panel open', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/evaluations');
    await user.click(await screen.findByRole('button', { name: /Prompt injection/ }));
    await screen.findByText('Expected behaviour');
    await expectNoSeriousA11yIssues(container);
  });

  it('knowledge', async () => {
    const { container } = renderAt('/knowledge');
    await screen.findByText('refunds');
    await expectNoSeriousA11yIssues(container);
  });

  it('tenants and configuration', async () => {
    const { container } = renderAt('/tenants/skylink-air');
    await screen.findByText(/SkyLink Air configuration/);
    await expectNoSeriousA11yIssues(container);
  });

  it('voice lab', async () => {
    const { container } = renderAt('/voice');
    await screen.findByText('Talk to the agent');
    await expectNoSeriousA11yIssues(container);
  });

  it('architecture', async () => {
    const { container } = renderAt('/architecture');
    await screen.findByText(/What happens to every message/);
    await expectNoSeriousA11yIssues(container);
  });

  it('command palette dialog', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByText('Evaluation quality');
    await user.click(screen.getByRole('button', { name: /Search pages and tenants/ }));
    const dialog = await screen.findByRole('dialog');
    await expectNoSeriousA11yIssues(dialog);
  });

  it('error state is announced with role=alert and offers a retry', async () => {
    mocked.clients.mockRejectedValueOnce(
      new Error("Can't reach the server. Is the backend running?"),
    );
    renderAt('/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't reach the server");
    mocked.clients.mockResolvedValue(clients);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Evaluation quality')).toBeInTheDocument());
  });
});

describe('behaviour', () => {
  it('the approval card sends the customer reply as a normal chat message', async () => {
    mocked.chat.mockResolvedValue(
      reply({
        phase: 'AWAITING_APPROVAL',
        pendingApproval: {
          summary: 'Move booking SK1001 to flight SK110',
          expiresAt: '2026-11-10T10:10:00.000Z',
        },
      }),
    );
    const user = userEvent.setup();
    renderAt('/agent/skylink-air');
    await user.click(await screen.findByRole('button', { name: 'My flight was cancelled' }));
    const card = await screen.findByRole('region', { name: 'Approval needed' });
    expect(within(card).getByText(/Move booking SK1001/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Yes, go ahead/ }));
    await waitFor(() =>
      expect(mocked.chat).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: 'Yes, please go ahead.' }),
      ),
    );
  });

  it('shows the agent state as text, not just visuals', async () => {
    const user = userEvent.setup();
    renderAt('/agent/skylink-air');
    await screen.findByText(/Hi, I'm Ava/);
    expect(
      screen.getAllByRole('status').some((s) => /Ava is ready/.test(s.textContent ?? '')),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'My flight was cancelled' }));
    await screen.findByText(/Happy to help/);
  });

  it('switching tenant rescopes the pages', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByText('Evaluation quality');
    await user.selectOptions(screen.getByLabelText('Tenant'), 'novatel');
    await waitFor(() => expect(mocked.overview).toHaveBeenLastCalledWith('novatel'));
  });

  it('never shows a made-up number: unrecorded token usage says so', async () => {
    renderAt('/');
    await screen.findByText('Evaluation quality');
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThanOrEqual(2);
  });

  it('old URLs still work', async () => {
    renderAt('/inbox');
    await screen.findAllByText('Customer asked for a human');
  });

  it('the mobile menu opens a labelled navigation dialog', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(dialog).getByRole('link', { name: /Traces/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('config change controls are visibly unavailable', async () => {
    renderAt('/tenants/skylink-air');
    await screen.findByText(/SkyLink Air configuration/);
    for (const name of ['Save', 'Publish', 'Roll back'])
      expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  describe('human handoff', () => {
    const accepted = { ...handoff, status: 'accepted' as const };
    const withMessages = {
      ...conversationView,
      messages: [
        {
          role: 'user' as const,
          content: 'I want a person',
          createdAt: '2026-11-10T09:00:00.000Z',
        },
        {
          role: 'human' as const,
          content: 'Hi, this is Sam.',
          createdAt: '2026-11-10T09:01:00.000Z',
        },
      ],
    };

    it('cannot reply before the handoff is accepted', async () => {
      renderAt('/handoffs');
      const box = await screen.findByLabelText('Reply to the customer');
      expect(box).toBeDisabled();
      expect(screen.getByRole('button', { name: /Send reply/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Resolve' })).toBeDisabled();
    });

    it('sends a reply and resolves, and the page has no serious a11y issues', async () => {
      mocked.handoffs.mockResolvedValue([accepted]);
      mocked.conversation.mockResolvedValue(withMessages);
      mocked.replyHandoff.mockResolvedValue({ ok: true });
      mocked.resolveHandoff.mockResolvedValue({ ...accepted, status: 'resolved' });
      const user = userEvent.setup();
      const { container } = renderAt('/handoffs');
      const box = await screen.findByLabelText('Reply to the customer');
      await screen.findByText(/Hi, this is Sam\./);
      expect(box).toBeEnabled();
      await expectNoSeriousA11yIssues(container);

      await user.type(box, 'Let me check your booking.');
      await user.click(screen.getByRole('button', { name: /Send reply/ }));
      await waitFor(() =>
        expect(mocked.replyHandoff).toHaveBeenCalledWith('h1', 'Let me check your booking.'),
      );
      await waitFor(() => expect(box).toHaveValue(''));

      await user.click(screen.getByRole('button', { name: 'Resolve' }));
      await waitFor(() => expect(mocked.resolveHandoff).toHaveBeenCalledWith('h1'));
    });

    it('shows a reply error instead of failing silently', async () => {
      mocked.handoffs.mockResolvedValue([accepted]);
      mocked.conversation.mockResolvedValue(withMessages);
      mocked.replyHandoff.mockRejectedValue(new Error('This handoff is already resolved'));
      const user = userEvent.setup();
      renderAt('/handoffs');
      await user.type(await screen.findByLabelText('Reply to the customer'), 'Hello');
      await user.click(screen.getByRole('button', { name: /Send reply/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('already resolved');
    });

    it("the customer's chat picks up the human's reply", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mocked.chat.mockResolvedValue({
          ...reply({ phase: 'HANDOFF', handedOff: true }),
          reply: 'I am handing you over.',
        });
        mocked.conversation.mockResolvedValue({
          ...withMessages,
          state: { ...withMessages.state, handedOff: true },
        });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderAt('/agent/skylink-air');
        await user.click(await screen.findByRole('button', { name: 'My flight was cancelled' }));
        await screen.findByText('I am handing you over.');
        await vi.advanceTimersByTimeAsync(3500);
        const human = await screen.findByText('Hi, this is Sam.');
        expect(human.closest('li')).toHaveTextContent('Human colleague');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
