import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkMarkdown, decide, tokenize, type Ranked } from '@backend/knowledge';
import { NO_POLICY_REPLY } from '@backend/knowledge/types';
import { DEFAULT_RETRIEVAL } from '@backend/knowledge/retrieve';
import { createRetriever, localProvider } from '@backend/knowledge';
import { createLogger } from '@backend/logger';
import { knowledgeRepo } from '@backend/database';
import { createHarness, say, type Harness } from '../helpers/harness';

describe('chunking', () => {
  it('splits by heading and keeps the document title in the heading', () => {
    const chunks = chunkMarkdown(
      'doc',
      '# Title\n\n## A\nFirst section has enough text to keep.\n\n## B\nSecond section also long enough.',
    );
    expect(chunks.map((c) => c.heading)).toEqual(['Title > A', 'Title > B']);
    expect(chunks.every((c) => c.source === 'doc')).toBe(true);
  });

  it('drops empty sections and splits very long ones', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`).join(
      '\n\n',
    );
    const chunks = chunkMarkdown('doc', `# T\n\n## Empty\n\n## Long\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 1400)).toBe(true);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    ingestKnowledge: true,
    classify: (m) => ({ intent: 'baggage_policy', isPolicyQuestion: /\?/.test(m) }),
  });
});
afterAll(() => h.close());

describe('retrieval (RAG)', () => {
  const retrieve = () => createRetriever(h.db.db, localProvider, createLogger('silent'));

  it('ingested 10-12 policy documents with source and updated_at', async () => {
    const sources = new Set(
      (
        (await h.db.db.execute(
          (await import('drizzle-orm'))
            .sql`SELECT DISTINCT source FROM knowledge_chunks WHERE client_id = 'skylink-air'`,
        )) as unknown as { rows: unknown[] }
      ).rows.map((r) => (r as { source: string }).source),
    );
    expect(sources.size).toBeGreaterThanOrEqual(10);
    expect(sources.size).toBeLessThanOrEqual(12);
    expect(await knowledgeRepo.countChunks(h.db.db, 'skylink-air')).toBeGreaterThan(15);
  });

  it.each([
    ['How many bags can I check?', 'checked-baggage'],
    ['What is the change fee if I move my flight?', 'voluntary-changes-and-fees'],
    ['Can I get a refund for a cancelled flight?', 'refunds'],
    ['Can I bring my dog on the plane?', 'special-baggage-pets-sports'],
    ['Can my puppy sit with me on board?', 'special-baggage-pets-sports'],
    ['Can I get my money back on a cheap saver ticket?', 'refunds'],
    ['My luggage never arrived, what compensation do I get?', 'delayed-and-lost-baggage'],
    ['What time does check-in close?', 'check-in-and-boarding'],
  ])('finds the right policy for "%s"', async (question, source) => {
    const res = await retrieve()('skylink-air', question);
    expect(res.relevant).toBe(true);
    expect(res.citations.map((c) => c.source)).toContain(source);
    expect(res.citations[0]?.snippet.length).toBeGreaterThan(20);
    expect(res.citations.length).toBeLessThanOrEqual(DEFAULT_RETRIEVAL.maxResults);
  });

  it('uses retrieval-only expansions for a telecom no-service question', async () => {
    const res = await retrieve()('novatel', 'no service on my phone');
    expect(res.relevant).toBe(true);
    expect(res.citations.some((citation) => citation.source === 'outage-credits')).toBe(true);
  });

  it.each([
    'Can I put sporting bats in checked baggage?',
    'Can my puppy sit with me on board?',
    'Can I get my money back on a cheap saver ticket?',
  ])('retains supported paraphrase evidence for "%s"', async (question) => {
    const res = await retrieve()('skylink-air', question);
    expect(res.relevant).toBe(true);
    expect(res.citations.length).toBeGreaterThan(0);
  });

  it('does not use another tenant’s baggage policy for NovaTel', async () => {
    const res = await retrieve()('novatel', 'How many checked bags can I take in economy?');
    expect(res.citations.map((citation) => citation.source)).not.toContain('checked-baggage');
  });

  it.each([
    'Do you offer free rocket rides to the moon?',
    'What is the capital of Australia?',
    'Can you recommend a good pizza restaurant?',
    'Can I carry a weapon not covered by the baggage guide?',
  ])('finds nothing relevant for "%s"', async (question) => {
    const res = await retrieve()('skylink-air', question);
    expect(res.relevant).toBe(false);
    expect(res.citations).toHaveLength(0);
  });

  it('puts retrieved policy and its source into the model prompt and returns citations', async () => {
    h.llm.reset();
    h.llm.script(say('You can check one bag in Economy [Source: checked-baggage].'));
    const res = await h.chat.chat({
      clientId: 'skylink-air',
      message: 'How many bags can I check?',
    });
    expect(h.llm.calls[0]!.system).toContain('[Source: checked-baggage]');
    expect(res.citations.map((c) => c.source)).toContain('checked-baggage');
    expect(res.reply).toContain('checked-baggage');
    const view = await h.chat.view(res.conversationId);
    expect(view.citations.length).toBeGreaterThan(0); // "Knowledge used" survives a reload
  });

  it('answers an unknown policy question with the safe fallback and never calls the model to improvise', async () => {
    h.llm.reset();
    h.llm.script(say('Sure! Rockets are free on Tuesdays.')); // must never be used
    const res = await h.chat.chat({
      clientId: 'skylink-air',
      message: 'Do you offer free rocket rides to the moon?',
    });
    expect(res.reply).toBe(NO_POLICY_REPLY);
    expect(res.reply).toMatch(/not sure/i);
    expect(res.reply).toMatch(/human agent/i);
    expect(h.llm.calls).toHaveLength(0);
    expect(res.citations).toHaveLength(0);
  });

  it('continues with a supported policy answer after the customer declines a human transfer', async () => {
    h.llm.reset();
    h.llm.script(say('Refunds are processed within 7 business days [Source: refunds].'));
    const offered = await h.chat.chat({
      clientId: 'skylink-air',
      message: 'Do you offer free rocket rides to the moon?',
      channel: 'voice',
    });
    expect(offered.reply).toBe(NO_POLICY_REPLY);
    expect(offered.handoff).toBeUndefined();

    const answer = await h.chat.chat({
      clientId: 'skylink-air',
      conversationId: offered.conversationId,
      message: 'No human transfer, please. How long do refunds take after airline cancellation?',
      channel: 'voice',
    });
    expect(answer.reply).toContain('7 business days');
    expect(answer.reply).not.toMatch(/human agent|connect you/i);
    expect(answer.citations.some((citation) => citation.source === 'refunds')).toBe(true);
    expect(h.llm.calls).toHaveLength(1);
  });
});

describe('retrieval evidence decisions', () => {
  const candidate = (rerank: number, overlap: number, queryExpanded = false): Ranked => ({
    hit: {
      id: 'marginal-topic-match',
      documentId: 'doc-1',
      source: 'carry-on-baggage',
      heading: 'Items not allowed in the cabin',
      content: 'Sharp objects, sporting bats and any flammable items must be placed in checked baggage.',
      page: null,
      pageEnd: null,
      version: 1,
      score: 0.73,
    },
    similarity: 0.73,
    keyword: 0.49,
    overlap,
    score: 0.6,
    rerank,
    queryExpanded,
  });

  it('rejects a marginal topical match without independent query-term coverage', () => {
    const decision = decide([candidate(-1.6, 0.5)]);
    expect(decision.relevant).toBe(false);
    expect(decision.passages).toHaveLength(0);
  });

  it('keeps marginal but corroborated paraphrases and strong semantic matches', () => {
    expect(decide([candidate(-1.8, 0.6)]).relevant).toBe(true);
    expect(decide([candidate(1.2, 0.5)]).relevant).toBe(true);
  });

  it('rejects a high reranker score when only generic topic words match', () => {
    const topicalOnly = candidate(0.6, 0.4);
    topicalOnly.specificTermCoverage = 0;
    expect(decide([topicalOnly]).relevant).toBe(false);
  });

  it('normalizes a hard change-fee paraphrase to a supported policy term', () => {
    expect(tokenize('switching to another flight')).toContain('change');
  });

  it('only admits weak matches when reviewed expansion or context added a search path', () => {
    expect(decide([candidate(-5, 0.5)]).relevant).toBe(false);
    const expanded = decide([candidate(-5, 0.5, true)]);
    expect(expanded.relevant).toBe(true);
    expect(expanded.weak).toBe(true);
  });
});
