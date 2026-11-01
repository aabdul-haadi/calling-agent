import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDoc, KnowledgeSearchResult } from '@adk/shared';
import { AppRoutes } from '@/App';
import { keyTerms } from '@/pages/knowledge';
import { formatBytes } from '@/lib/utils';
import { api } from '@/services/api';
import { clientDetail, clients, overview } from './fixtures';

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  return {
    ...actual,
    api: {
      authConfig: vi.fn(),
      health: vi.fn(),
      clients: vi.fn(),
      client: vi.fn(),
      overview: vi.fn(),
      knowledge: vi.fn(),
      uploadKnowledge: vi.fn(),
      reindexKnowledge: vi.fn(),
      retryKnowledge: vi.fn(),
      deleteKnowledge: vi.fn(),
      searchKnowledge: vi.fn(),
    },
  };
});
const mocked = vi.mocked(api);

const builtIn: KnowledgeDoc = {
  source: 'refunds',
  title: 'Refunds',
  origin: 'folder',
  version: 1,
  status: 'ready',
  chunks: 3,
  headings: ['Refund timing'],
  characters: 1400,
  updatedAt: '2026-11-10T08:00:00.000Z',
};
const handbook: KnowledgeDoc = {
  id: 'd1',
  source: 'handbook.pdf',
  origin: 'upload',
  version: 2,
  status: 'ready',
  pages: 55,
  ocrPages: 5,
  sizeBytes: 3_400_000,
  chunks: 140,
  headings: ['Baggage', 'Refunds'],
  characters: 90000,
  warnings: [
    'page 1: text that reads like an instruction to an AI system was found; it is ignored when answering',
  ],
  updatedAt: '2026-11-10T09:00:00.000Z',
  versions: [
    {
      id: 'd0',
      version: 1,
      status: 'superseded',
      active: false,
      chunks: 0,
      pages: 50,
      updatedAt: '2026-11-01T09:00:00.000Z',
    },
  ],
};
const reading: KnowledgeDoc = {
  id: 'd2',
  source: 'terms.pdf',
  origin: 'upload',
  version: 1,
  status: 'extracting',
  stage: 'Reading page 12 of 80',
  progress: 15,
  chunks: 0,
  headings: [],
  characters: 0,
  updatedAt: '2026-11-10T09:30:00.000Z',
};
const failed: KnowledgeDoc = {
  id: 'd3',
  source: 'locked.pdf',
  origin: 'upload',
  version: 1,
  status: 'failed',
  error: { code: 'PASSWORD_PROTECTED', message: 'The PDF is password protected.' },
  chunks: 0,
  headings: [],
  characters: 0,
  updatedAt: '2026-11-10T09:40:00.000Z',
};

const found: KnowledgeSearchResult = {
  question: 'How long does a refund take?',
  searched: 'How long does a refund take?',
  relevant: true,
  reason: '2 passage(s) supported the question.',
  embedding: 'bge-small (local)',
  considered: 9,
  timings: { embedMs: 12, vectorMs: 8, keywordMs: 6, rerankMs: 60, totalMs: 90 },
  passages: [
    {
      source: 'handbook.pdf',
      heading: 'Handbook > Refunds > Timelines',
      snippet: 'Refunds to a card are processed within 7 business days.',
      score: 0.8,
      page: 5,
      version: 2,
      match: { rerank: 7.4, vector: 0.81, keyword: 1 },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocked.authConfig.mockResolvedValue({ mode: 'development', issuer: null });
  mocked.health.mockResolvedValue({ status: 'ok', db: 'up' });
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.overview.mockResolvedValue(overview);
  mocked.knowledge.mockResolvedValue([builtIn, handbook, reading, failed]);
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/knowledge']}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('Knowledge page', () => {
  it('shows each document with its status, pages, progress, version and notes', async () => {
    renderPage();
    const hb = (await screen.findByText('handbook.pdf')).closest('div.flex.flex-col')!;
    expect(within(hb as HTMLElement).getByText(/55 pages/)).toBeInTheDocument();
    expect(within(hb as HTMLElement).getByText(/5 read by OCR/)).toBeInTheDocument();
    expect(within(hb as HTMLElement).getByText('v2')).toBeInTheDocument();
    expect(within(hb as HTMLElement).getByText('Ready')).toBeInTheDocument();
    expect(within(hb as HTMLElement).getByText(/1 note about this document/)).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: 'Progress for terms.pdf' });
    expect(bar).toHaveAttribute('aria-valuenow', '15');
    expect(screen.getByText('Reading page 12 of 80')).toBeInTheDocument();

    expect(screen.getByText('The PDF is password protected.')).toBeInTheDocument();
    expect(screen.getByText(/Remove the password in a PDF viewer/)).toBeInTheDocument();
    expect(screen.getByText('Built in')).toBeInTheDocument();
  });

  it('shows older versions on request', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Show 1 older version/ }));
    expect(screen.getByText(/Version 1 · Replaced/)).toBeInTheDocument();
  });

  it('uploads PDFs, tells the user it is read in the background, and refuses other files', async () => {
    const user = userEvent.setup({ applyAccept: false }); // a drag-and-drop can carry any file
    mocked.uploadKnowledge.mockResolvedValue({ document: reading, unchanged: false });
    renderPage();
    const input = await screen.findByLabelText('Choose PDF files to upload');
    const pdf = new File(['%PDF-1.4'], 'new-terms.pdf', { type: 'application/pdf' });
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(input, [pdf, txt]);
    await waitFor(() => expect(mocked.uploadKnowledge).toHaveBeenCalledTimes(1));
    expect(mocked.uploadKnowledge).toHaveBeenCalledWith('skylink-air', pdf);
    expect(
      await screen.findByText(/new-terms.pdf: uploaded\. It is being read now/),
    ).toBeInTheDocument();
    expect(screen.getByText(/notes.txt: only PDF files are supported/)).toBeInTheDocument();
  });

  it('says so when the exact same file is uploaded again', async () => {
    const user = userEvent.setup();
    mocked.uploadKnowledge.mockResolvedValue({ document: handbook, unchanged: true });
    renderPage();
    await user.upload(
      await screen.findByLabelText('Choose PDF files to upload'),
      new File(['%PDF'], 'handbook.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText(/already the current version/)).toBeInTheDocument();
  });

  it('asks before deleting, and never offers to delete a built-in file', async () => {
    const user = userEvent.setup();
    mocked.deleteKnowledge.mockResolvedValue({ removed: 'handbook.pdf' });
    renderPage();
    await screen.findByText('refunds');
    expect(screen.getAllByRole('button', { name: /Delete/ })).toHaveLength(3); // the three uploads, not the built-in file
    const hb = (await screen.findByText('handbook.pdf')).closest('div.flex.flex-col')!;
    await user.click(within(hb as HTMLElement).getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/all of its versions will be removed/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(mocked.deleteKnowledge).not.toHaveBeenCalled();
    await user.click(within(hb as HTMLElement).getByRole('button', { name: /Delete/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(mocked.deleteKnowledge).toHaveBeenCalledWith('skylink-air', 'd1'));
  });

  it('re-indexes a ready document and retries a failed one', async () => {
    const user = userEvent.setup();
    mocked.reindexKnowledge.mockResolvedValue(handbook);
    mocked.retryKnowledge.mockResolvedValue(failed);
    renderPage();
    const hb = (await screen.findByText('handbook.pdf')).closest('div.flex.flex-col')!;
    await user.click(within(hb as HTMLElement).getByRole('button', { name: /Re-index/ }));
    expect(mocked.reindexKnowledge).toHaveBeenCalledWith('skylink-air', 'd1');
    await user.click(within(hb as HTMLElement).getByRole('button', { name: /Re-read PDF/ }));
    expect(mocked.reindexKnowledge).toHaveBeenCalledWith('skylink-air', 'd1', true);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(mocked.retryKnowledge).toHaveBeenCalledWith('skylink-air', 'd3');
  });

  it('tests a question: shows the passage, its page and the scores, and checks the expected answer', async () => {
    const user = userEvent.setup();
    mocked.searchKnowledge.mockResolvedValue(found);
    renderPage();
    await user.type(await screen.findByLabelText('Question'), 'How long does a refund take?');
    await user.type(screen.getByLabelText(/Expected answer/), '7 business days');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocked.searchKnowledge).toHaveBeenCalledWith(
      'skylink-air',
      'How long does a refund take?',
      [],
    );
    const list = await screen.findByRole('list', { name: 'Passages found' });
    expect(within(list).getByText('handbook.pdf')).toBeInTheDocument();
    expect(within(list).getByText('page 5')).toBeInTheDocument();
    expect(within(list).getByText(/relevance 7.4/)).toBeInTheDocument();
    expect(screen.getByText('Evidence found')).toBeInTheDocument();
    expect(
      screen.getByText(/Expected answer: 3 of 3 key terms appear in the evidence/),
    ).toBeInTheDocument();
  });

  it('explains an abstention and shows the closest rejected passage', async () => {
    const user = userEvent.setup();
    mocked.searchKnowledge.mockResolvedValue({
      ...found,
      question: 'Do you fly to Mars?',
      searched: 'Do you fly to Mars?',
      relevant: false,
      reason: 'The closest passage (handbook.pdf) does not answer the question (relevance -9.0).',
      passages: [],
      closest: { ...found.passages[0]!, snippet: 'Airport check-in times.', match: { rerank: -9 } },
    });
    renderPage();
    await user.type(await screen.findByLabelText('Question'), 'Do you fly to Mars?');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByText(/Not covered: the agent would say it is not sure/),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not answer the question/)).toBeInTheDocument();
    expect(screen.getByText('Closest passage (rejected)')).toBeInTheDocument();
  });

  it('sends the earlier question so a follow-up can be tested', async () => {
    const user = userEvent.setup();
    mocked.searchKnowledge.mockResolvedValue({
      ...found,
      searched: 'What is the refund policy? And how long does it take?',
    });
    renderPage();
    await user.type(await screen.findByLabelText('Question'), 'And how long does it take?');
    await user.type(screen.getByLabelText(/Earlier question/), 'What is the refund policy?');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocked.searchKnowledge).toHaveBeenCalledWith(
      'skylink-air',
      'And how long does it take?',
      ['What is the refund policy?'],
    );
    expect(await screen.findByText(/Searched for:/)).toBeInTheDocument();
  });

  it('has no serious accessibility problems', async () => {
    const { container } = renderPage();
    await screen.findByText('handbook.pdf');
    const r = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(
      r.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
    ).toEqual([]);
  });
});

describe('helpers', () => {
  it('picks the meaningful terms of an expected answer', () => {
    expect(keyTerms('7 business days, no fee of $45.50')).toEqual([
      '7',
      'business',
      'days',
      '$45.50',
    ]);
  });
  it('formats sizes', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3_400_000)).toBe('3.2 MB');
  });
});
