import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/App';
import { api, type LearningRelease, type LearningTurn } from '@/services/api';
import { clientDetail, clients, overview } from './fixtures';

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  const learning = {
    overview: vi.fn(),
    turns: vi.fn(),
    review: vi.fn(),
    gaps: vi.fn(),
    gapStatus: vi.fn(),
    datasets: vi.fn(),
    buildDataset: vi.fn(),
    datasetUrl: vi.fn(() => '#'),
    releases: vi.fn(),
    release: vi.fn(),
    rollback: vi.fn(),
    tuneRetrieval: vi.fn(),
    trainIntent: vi.fn(),
    proposeBehavior: vi.fn(),
    jobs: vi.fn(),
    runCycle: vi.fn(),
  };
  return {
    ...actual,
    api: { health: vi.fn(), clients: vi.fn(), client: vi.fn(), overview: vi.fn(), learning },
  };
});
const mocked = vi.mocked(api);

const turn: LearningTurn = {
  id: 't1',
  channel: 'voice',
  intent: 'baggage_policy',
  sentiment: 'neutral',
  customerText: 'how many bags can i check',
  aiReply: 'One bag is free in Economy.',
  humanReply: 'Economy gets one bag, Flex two.',
  sources: [{ source: 'checked-baggage', page: null, weak: false }],
  asksPolicy: true,
  abstained: false,
  handoffReason: null,
  resolution: 'unknown',
  rating: null,
  correction: null,
  flags: ['robotic_opener'],
  reviewStatus: 'pending',
  reviewer: null,
  approvedReply: null,
  split: 'train',
  createdAt: '2026-11-10T09:00:00.000Z',
};
const failing: LearningRelease = {
  id: 'r1',
  kind: 'behavior',
  channel: 'voice',
  version: 1,
  status: 'candidate',
  note: 'behaviour lessons',
  params: { rollout: 25, config: {} },
  evaluation: {
    passed: false,
    gates: [
      { name: 'lessons are allowed', pass: true, detail: 'ok' },
      { name: 'live reply check with the real model', pass: false, detail: 'not run yet' },
    ],
  },
  createdBy: 'maria',
  deployedAt: null,
  createdAt: '2026-11-10T09:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocked.health.mockResolvedValue({ status: 'ok', db: 'up' });
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.overview.mockResolvedValue(overview);
  mocked.learning.overview.mockResolvedValue({
    review: { pending: 4, approved: 2 },
    capture: { queued: 0, stored: 6, duplicates: 0, excluded: 1, failed: 0 },
    byChannel: { voice: 3, chat: 3 },
    flags: {},
    openGaps: 1,
    datasets: 0,
    shadow: {},
    thresholds: { minSftExamples: 200, minIntentExamples: 30, retentionDays: 90 },
  });
  mocked.learning.turns.mockResolvedValue([turn]);
  mocked.learning.releases.mockResolvedValue([failing]);
  mocked.learning.gaps.mockResolvedValue([]);
  mocked.learning.datasets.mockResolvedValue([]);
  mocked.learning.jobs.mockResolvedValue([]);
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/learning']}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('Learning console', () => {
  it('shows what calls and chats produced, with the human answer marked as unverified', async () => {
    renderPage();
    expect(await screen.findByText('how many bags can i check')).toBeInTheDocument();
    expect(screen.getByText('Call')).toBeInTheDocument();
    expect(screen.getByText('Stock opening phrase')).toBeInTheDocument();
    expect(screen.getByText(/unverified lead/i)).toBeInTheDocument();
    expect((await screen.findAllByText('Waiting for review')).length).toBeGreaterThan(0);
  });

  it('approving sends the edited reply and what it is for, then reloads', async () => {
    mocked.learning.review.mockResolvedValue({ ...turn, reviewStatus: 'approved' });
    renderPage();
    await screen.findByText('how many bags can i check');
    const box = screen.getByLabelText(/Approved reply/i);
    await userEvent.clear(box);
    await userEvent.type(box, 'One bag is free in Economy and two in Flex.');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocked.learning.review).toHaveBeenCalled());
    const [, id, body] = mocked.learning.review.mock.calls[0]!;
    expect(id).toBe('t1');
    expect(body).toMatchObject({ decision: 'approve', approvedReply: 'One bag is free in Economy and two in Flex.', uses: ['sft'] });
  });

  it('shows a server refusal to the reviewer instead of hiding it', async () => {
    const { ApiError } = await import('@/services/api');
    mocked.learning.review.mockRejectedValue(new ApiError('INVALID', 'The approved reply still contains secret'));
    renderPage();
    await screen.findByText('how many bags can i check');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/secret/);
  });

  it('a release that failed a gate cannot be deployed, and says which gate', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: /Evaluation and releases/ }));
    expect(await screen.findByText('live reply check with the real model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();
    expect(screen.getByText('25% of conversations')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderPage();
    await screen.findByText('how many bags can i check');
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => v.id + ': ' + v.nodes[0]?.html)).toEqual([]);
  });
});
