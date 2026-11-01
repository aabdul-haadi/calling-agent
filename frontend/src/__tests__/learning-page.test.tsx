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
    hardware: vi.fn(),
    runs: vi.fn(),
    startRun: vi.fn(),
    runAction: vi.fn(),
    modelAction: vi.fn(),
    shadowReport: vi.fn(),
    proposals: vi.fn(),
    diagnosis: vi.fn(),
    uploadProposal: vi.fn(),
    proposalAction: vi.fn(),
  };
  return {
    ...actual,
    api: {
      authConfig: vi.fn(),
      health: vi.fn(),
      clients: vi.fn(),
      client: vi.fn(),
      overview: vi.fn(),
      learning,
    },
  };
});
const mocked = vi.mocked(api, true);

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
  mocked.authConfig.mockResolvedValue({ mode: 'development', issuer: null });
  mocked.health.mockResolvedValue({ status: 'ok', db: 'up' });
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.overview.mockResolvedValue(overview);
  mocked.learning.overview.mockResolvedValue({
    eligibility: { authorized: true, source: 'tenant_allow_list' },
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
  mocked.learning.hardware.mockResolvedValue({
    verdict: 'not_ready',
    reason: 'only 2.3 GB of memory is free and this model needs about 3.6 GB while training',
    cpuThreads: 8,
    ramGb: 16,
    ramAvailableGb: 2.3,
    gpu: null,
    libraries: { torch: '2.14.1+cpu', peft: null },
    base: 'Qwen/Qwen2.5-0.5B-Instruct',
    estimatedTrainingMemoryGb: 3.6,
  });
  mocked.learning.runs.mockResolvedValue([]);
  mocked.learning.proposals.mockResolvedValue([]);
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

  it('explains when tenant authorization blocks conversation-derived learning', async () => {
    mocked.learning.overview.mockResolvedValue({
      eligibility: { authorized: false, source: 'tenant_allow_list' },
      review: {},
      capture: { queued: 0, stored: 0, duplicates: 0, excluded: 0, failed: 0 },
      byChannel: {},
      flags: {},
      openGaps: 0,
      datasets: 0,
      shadow: {},
      thresholds: { minSftExamples: 200, minIntentExamples: 30, retentionDays: 90 },
    });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/LEARNING_AUTHORIZED_CLIENTS/);
    expect(screen.getByRole('button', { name: 'Run a learning cycle' })).toBeDisabled();
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


describe('Learning console: training and knowledge changes', () => {
  const run = (over: object) => ({
    id: 'run-aaaaaaaa',
    kind: 'train',
    base: 'Qwen/Qwen2.5-0.5B-Instruct',
    status: 'running',
    progress: { step: 3, of: 10, loss: 2.1 },
    logTail: '{"event":"step"}',
    metrics: {},
    error: null,
    releaseId: null,
    startedAt: '2026-11-10T09:00:00.000Z',
    finishedAt: null,
    ...over,
  });

  it('shows the machine honestly, with the reason training is not ready', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Training' }));
    expect(await screen.findByText('Not ready')).toBeInTheDocument();
    expect(screen.getByText(/only 2.3 GB of memory is free/)).toBeInTheDocument();
    expect(screen.getByText(/peft missing/)).toBeInTheDocument();
  });

  it('shows real job progress and offers cancel while running, resume when interrupted', async () => {
    mocked.learning.datasets.mockResolvedValue([]);
    mocked.learning.runs.mockResolvedValue([
      run({}),
      run({ id: 'run-bbbbbbbb', status: 'interrupted', error: 'The server restarted while this run was in progress.' }),
      run({ id: 'run-cccccccc', status: 'refused', error: 'Not trained: only 3 examples; the recorded minimum is 200.' }),
    ] as never);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Training' }));
    expect((await screen.findAllByText(/Step 3 of 10, loss 2.1/)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Cancel/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Resume/ })).toHaveLength(1);
    expect(screen.getByText(/only 3 examples; the recorded minimum is 200/)).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '3');
  });

  it('a test run is labelled as never becoming a model', async () => {
    mocked.learning.runs.mockResolvedValue([run({ kind: 'smoke', status: 'done', progress: { step: 4, of: 4 } })] as never);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Training' }));
    expect(await screen.findByText(/never offered as a model/)).toBeInTheDocument();
  });

  it('explains why a gap is a gap and refuses nothing silently; a failed gate keeps Approve disabled', async () => {
    mocked.learning.gaps.mockResolvedValue([
      { id: 'g1', label: 'nova, plus', examples: ['How much is Nova Plus?'], occurrences: 3, channels: ['voice', 'chat'], status: 'open', suggestion: {} },
    ]);
    mocked.learning.diagnosis.mockResolvedValue({ cause: 'missing_information', evidence: ['No passage shares the topic words'], recommendation: 'Upload the approved document that defines the policy.', change: 'document' });
    mocked.learning.proposals.mockResolvedValue([
      {
        id: 'p1',
        gapId: 'g1',
        title: 'Nova Plus prices',
        docName: 'nova-plus-prices.pdf',
        attestation: { sourceType: 'official_document', owner: 'NovaTel Pricing', reference: 'Price list 2026' },
        status: 'evaluated',
        evaluation: { passed: false, gates: [{ name: 'citation accuracy does not drop', pass: false, detail: '100.0% to 87.5%', verdict: 'fail' }] },
        reviewer: 'maria',
        note: null,
        createdAt: '2026-11-10T09:00:00.000Z',
      },
    ] as never);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Knowledge changes' }));
    expect(await screen.findByText('The documents never covered this')).toBeInTheDocument();
    expect(screen.getByText(/A chat or a call is never a source/)).toBeInTheDocument();
    expect(await screen.findByText(/citation accuracy does not drop/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('a candidate model offers comparison and shadow, and Promote stays disabled until it passed', async () => {
    mocked.learning.releases.mockResolvedValue([
      {
        id: 'm1', kind: 'llm_adapter', channel: 'both', version: 1, status: 'shadow', note: 'LoRA', params: { rollout: 100, config: { base: 'Qwen/Qwen2.5-0.5B-Instruct' } },
        evaluation: { passed: false, inconclusive: true, gates: [{ name: 'enough held-out examples', pass: false, detail: '4 held-out examples; at least 30 are needed', verdict: 'inconclusive' }] },
        createdBy: 'trainer', deployedAt: null, createdAt: '2026-11-10T09:00:00.000Z',
      },
    ] as never);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: /Evaluation and releases/ }));
    expect(await screen.findByText(/Inconclusive: there is not enough evidence/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
    expect(screen.getByText(/it has no tools, so it cannot change a booking/)).toBeInTheDocument();
  });
});
