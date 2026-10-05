import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkMarkdown } from '@backend/knowledge';
import { NO_POLICY_REPLY } from '@backend/knowledge/types';
import { createRetriever, localProvider } from '@backend/knowledge';
import { createLogger } from '@backend/logger';
import { knowledgeRepo } from '@backend/database';
import { createHarness, say, type Harness } from '../helpers/harness';

describe('chunking', () => {
  it('splits by heading and keeps the document title in the heading', () => {
    const chunks = chunkMarkdown('doc', '# Title\n\n## A\nFirst section has enough text to keep.\n\n## B\nSecond section also long enough.');
    expect(chunks.map((c) => c.heading)).toEqual(['Title > A', 'Title > B']);
    expect(chunks.every((c) => c.source === 'doc')).toBe(true);
  });

  it('drops empty sections and splits very long ones', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`).join('\n\n');
    const chunks = chunkMarkdown('doc', `# T\n\n## Empty\n\n## Long\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 1400)).toBe(true);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ingestKnowledge: true, classify: (m) => ({ intent: 'baggage_policy', isPolicyQuestion: /\?/.test(m) }) });
});
afterAll(() => h.close());

describe('retrieval (RAG)', () => {
  const retrieve = () => createRetriever(h.db.db, localProvider, createLogger('silent'));

  it('ingested 10-12 policy documents with source and updated_at', async () => {
    const sources = new Set((await h.db.db.execute((await import('drizzle-orm')).sql`SELECT DISTINCT source FROM knowledge_chunks WHERE client_id = 'skylink-air'`) as unknown as { rows: unknown[] }).rows.map((r) => (r as { source: string }).source));
    expect(sources.size).toBeGreaterThanOrEqual(10);
    expect(sources.size).toBeLessThanOrEqual(12);
    expect(await knowledgeRepo.countChunks(h.db.db, 'skylink-air')).toBeGreaterThan(15);
  });

  it.each([
    ['How many bags can I check?', 'checked-baggage'],
    ['What is the change fee if I move my flight?', 'voluntary-changes-and-fees'],
    ['Can I get a refund for a cancelled flight?', 'refunds'],
    ['Can I bring my dog on the plane?', 'special-baggage-pets-sports'],
    ['My luggage never arrived, what compensation do I get?', 'delayed-and-lost-baggage'],
    ['What time does check-in close?', 'check-in-and-boarding'],
  ])('finds the right policy for "%s"', async (question, source) => {
    const res = await retrieve()('skylink-air', question);
    expect(res.relevant).toBe(true);
    expect(res.citations.map((c) => c.source)).toContain(source);
    expect(res.citations[0]?.snippet.length).toBeGreaterThan(20);
    expect(res.citations.length).toBeLessThanOrEqual(3);
  });

  it.each([
    'Do you offer free rocket rides to the moon?',
    'What is the capital of Australia?',
    'Can you recommend a good pizza restaurant?',
  ])('finds nothing relevant for "%s"', async (question) => {
    const res = await retrieve()('skylink-air', question);
    expect(res.relevant).toBe(false);
    expect(res.citations).toHaveLength(0);
  });

  it('puts retrieved policy and its source into the model prompt and returns citations', async () => {
    h.llm.reset();
    h.llm.script(say('You can check one bag in Economy [Source: checked-baggage].'));
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'How many bags can I check?' });
    expect(h.llm.calls[0]!.system).toContain('[Source: checked-baggage]');
    expect(res.citations.map((c) => c.source)).toContain('checked-baggage');
    expect(res.reply).toContain('checked-baggage');
    const view = await h.chat.view(res.conversationId);
    expect(view.citations.length).toBeGreaterThan(0); // "Knowledge used" survives a reload
  });

  it('answers an unknown policy question with the safe fallback and never calls the model to improvise', async () => {
    h.llm.reset();
    h.llm.script(say('Sure! Rockets are free on Tuesdays.')); // must never be used
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'Do you offer free rocket rides to the moon?' });
    expect(res.reply).toBe(NO_POLICY_REPLY);
    expect(res.reply).toMatch(/not sure/i);
    expect(res.reply).toMatch(/human agent/i);
    expect(h.llm.calls).toHaveLength(0);
    expect(res.citations).toHaveLength(0);
  });
});

