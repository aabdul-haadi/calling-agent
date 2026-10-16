import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ClientRegistry } from '../clients';
import { knowledgeRepo, type Db } from '../database';
import { decide, toCitation, type KnowledgeService, type Searcher } from '../knowledge';
import type { Logger } from '../logger';
import { topicWords } from './gaps';
import { EVAL_SETS, type RetrievalCase } from './evalsets';
import { rankCases, scoreRetrieval, type RankedCase } from './evaluate';
import type { MlStore, ProposalRow } from './ml-store';
import type { Evaluation, Gate, Registry } from './registry';
import type { GapRow, LearningStore } from './store';

// Turns a recurring unanswered question into a reviewed change to the knowledge base. The order is
// fixed: diagnose why it fails, attach an approved source document, build a throwaway candidate
// index beside the live one, measure both on the same questions, let a person approve, then publish
// through the normal versioned upload (atomic) and keep a way back. A conversation is never a source.

export class KnowledgeChangeError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID' | 'NOT_EVALUATED' | 'GATES_FAILED' | 'NOT_APPROVED' | 'FAILED',
    message: string,
  ) {
    super(message);
  }
}

export type Cause =
  | 'missing_information'
  | 'threshold_too_strict'
  | 'ranking_problem'
  | 'extraction_problem'
  | 'possible_conflict'
  | 'should_stay_unanswered';

export interface Diagnosis {
  cause: Cause;
  evidence: string[];
  recommendation: string;
  /** What kind of change is the smallest justified one. */
  change: 'document' | 'retrieval_settings' | 'review_document' | 'resolve_conflict' | 'none';
}

const numbers = (s: string) => new Set(s.match(/\b\d+(?:\.\d+)?\b/g) ?? []);

export interface KnowledgeChangeDeps {
  db: Db;
  logger: Logger;
  registry: ClientRegistry;
  store: LearningStore;
  ml: MlStore;
  releases: Registry;
  knowledge: KnowledgeService;
  searcher: Searcher;
  dataDir: string;
  /** Wait for a candidate index to build. */
  buildTimeoutMs?: number;
}

export function createKnowledgeChange(deps: KnowledgeChangeDeps) {
  const { ml, store, knowledge, searcher, logger } = deps;
  const buildTimeout = deps.buildTimeoutMs ?? 10 * 60_000;
  const fileOf = (id: string) => resolve(deps.dataDir, 'learning', 'proposals', `${id}.pdf`);

  const module = (clientId: string) => {
    const m = deps.registry.get(clientId);
    if (!m) throw new KnowledgeChangeError('NOT_FOUND', `Unknown client "${clientId}"`);
    return m;
  };

  // ---- 1. diagnose -----------------------------------------------------------------------------

  /**
   * Looks at what the search actually did with a gap's questions and names the smallest change that
   * would help. It never recommends rewriting the system when a threshold or one document would do.
   */
  async function diagnose(clientId: string, gap: GapRow): Promise<Diagnosis> {
    const m = module(clientId);
    const examples = (gap.examples as string[]).slice(0, 5);
    const words = new Set(examples.flatMap(topicWords));
    // The terms every example shares say what the questions are really about ("nova", "plus"), as
    // opposed to words a whole policy library uses ("plan", "cost").
    const perExample = examples.map((q) => new Set(topicWords(q)));
    let keyTerms = [...words].filter((w) => perExample.every((e) => e.has(w)));
    if (keyTerms.length === 0) {
      const freq = new Map<string, number>();
      for (const e of perExample) for (const w of e) freq.set(w, (freq.get(w) ?? 0) + 1);
      keyTerms = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([w]) => w);
    }
    // Out of scope only when the whole declared topic is what was asked about, not when one word is shared.
    const outOfScope = m.config.outOfScope.some((o: string) => {
      const t = topicWords(o);
      return t.length > 0 && t.every((w) => words.has(w));
    });
    const docs = await knowledge.list(clientId);
    const evidence: string[] = [];

    const ranked = await rankCases(
      searcher,
      clientId,
      examples.map((q) => ({ q, source: null, channel: 'chat' as const })),
    );
    const cfg = searcher.config;
    let weakCandidate = 0;
    let overlapHits = 0;
    let conflict: string | undefined;
    for (const { set } of ranked) {
      const d = decide(set.ranked, cfg);
      const top = set.ranked[0];
      if (top) {
        const topWords = new Set(topicWords(top.hit.heading + ' ' + top.hit.content));
        const coversKeyTerms = keyTerms.length > 0 && keyTerms.every((w) => topWords.has(w));
        if (coversKeyTerms) overlapHits++;
        if (!d.relevant && coversKeyTerms && (top.rerank ?? -99) >= cfg.softRerank - 3) weakCandidate++;
        const second = set.ranked[1];
        if (second && second.hit.source !== top.hit.source) {
          const a = numbers(top.hit.content);
          const b = numbers(second.hit.content);
          const sameTopic = topicWords(top.hit.heading).some((w) => topicWords(second.hit.heading).includes(w));
          if (sameTopic && a.size > 0 && b.size > 0 && [...a].every((x) => !b.has(x)))
            conflict = `${top.hit.source} and ${second.hit.source} give different numbers under a similar heading`;
        }
      }
    }
    const broken = docs.filter((d) => d.status === 'failed' || (d.status === 'ready' && d.chunks === 0));
    if (broken.length > 0) {
      evidence.push(`${broken.length} document(s) failed or have no readable text: ${broken.map((b) => b.source).join(', ')}`);
      return {
        cause: 'extraction_problem',
        evidence,
        change: 'review_document',
        recommendation: 'A document failed to read. Fix or re-upload it (a scan may need OCR) before adding anything new.',
      };
    }
    if (outOfScope) {
      evidence.push('The topic matches something this company has declared out of scope.');
      return { cause: 'should_stay_unanswered', evidence, change: 'none', recommendation: 'Leave it unanswered: the agent should offer a person.' };
    }
    if (conflict) {
      evidence.push(conflict);
      return { cause: 'possible_conflict', evidence, change: 'resolve_conflict', recommendation: 'Two documents appear to disagree. A policy owner should decide which is correct and update the other.' };
    }
    if (weakCandidate >= Math.ceil(examples.length / 2)) {
      evidence.push(`${weakCandidate} of ${examples.length} questions had a close passage that scored just below the relevance bar.`);
      return { cause: 'threshold_too_strict', evidence, change: 'retrieval_settings', recommendation: 'The answer may already be in a document. Run the search-settings tuning and check it on held-out questions before adding a document.' };
    }
    if (overlapHits >= Math.ceil(examples.length / 2)) {
      evidence.push('Passages with the topic words exist, but ranked too low to be used.');
      return { cause: 'ranking_problem', evidence, change: 'retrieval_settings', recommendation: 'The topic is covered but ranked badly. Tune the search settings; consider a clearer heading in the document.' };
    }
    evidence.push(`No passage in ${docs.length} document(s) shares the topic words of these ${examples.length} questions.`);
    return { cause: 'missing_information', evidence, change: 'document', recommendation: 'The knowledge base does not contain this. Upload the approved document that defines the policy, with its owner as the source.' };
  }

  // ---- 2. propose ------------------------------------------------------------------------------

  async function propose(
    clientId: string,
    input: {
      gapId?: string | undefined;
      title: string;
      docName: string;
      bytes: Buffer;
      attestation: { sourceType: string; owner: string; reference: string };
      by: string;
    },
  ): Promise<ProposalRow> {
    module(clientId);
    const a = input.attestation;
    if (!['official_document', 'policy_owner_confirmation'].includes(a.sourceType))
      throw new KnowledgeChangeError('INVALID', 'A conversation, chat or call is not a source. Name the official document or the policy owner who confirmed it.');
    if (!a.owner.trim() || !a.reference.trim()) throw new KnowledgeChangeError('INVALID', 'Say who owns this policy and where it is published.');
    if (!/\.pdf$/i.test(input.docName)) throw new KnowledgeChangeError('INVALID', 'The document name must end in .pdf');
    if (!input.bytes.subarray(0, 1024).includes('%PDF-')) throw new KnowledgeChangeError('INVALID', 'This is not a PDF file');
    if (input.bytes.length > 100 * 1024 * 1024) throw new KnowledgeChangeError('INVALID', 'The file is larger than 100 MB');
    if (input.gapId) {
      const gaps = await store.listGaps(clientId);
      if (!gaps.some((g) => g.id === input.gapId)) throw new KnowledgeChangeError('NOT_FOUND', 'No such gap for this company');
    }
    const row = await ml.insertProposal({
      clientId,
      gapId: input.gapId ?? null,
      kind: 'document',
      title: input.title.slice(0, 160),
      docName: input.docName,
      attestation: { ...a, proposedBy: input.by },
      fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
      reviewer: input.by,
    });
    await mkdir(resolve(deps.dataDir, 'learning', 'proposals'), { recursive: true });
    await writeFile(fileOf(row.id), input.bytes);
    return (await ml.updateProposal(clientId, row.id, { filePath: fileOf(row.id) }))!;
  }

  // ---- 3. build a candidate index and measure it ----------------------------------------------

  const stem = (s: string) => s.replace(/\.(md|pdf)$/i, '').toLowerCase();

  async function evaluate(clientId: string, proposalId: string, by: string): Promise<ProposalRow> {
    const p = await ml.getProposal(clientId, proposalId);
    if (!p) throw new KnowledgeChangeError('NOT_FOUND', 'Proposal not found');
    if (!['draft', 'evaluated', 'failed'].includes(p.status)) throw new KnowledgeChangeError('INVALID', `A ${p.status} proposal cannot be evaluated again`);
    await ml.updateProposal(clientId, p.id, { status: 'building', note: null });
    const ns = `${clientId}~candidate~${p.id.slice(0, 8)}`;
    try {
      const bytes = await readFile(p.filePath!);
      const copied = await knowledgeRepo.cloneLiveInto(deps.db, clientId, ns);
      const up = await knowledge.upload(ns, p.docName!, bytes);
      const built = await knowledge.waitUntilSettled(ns, up.document.id!, buildTimeout);
      const gap = p.gapId ? (await store.listGaps(clientId)).find((g) => g.id === p.gapId) : undefined;
      const gapQuestions = (gap?.examples as string[] | undefined) ?? [];
      const newSource = stem(p.docName!);

      const base: RetrievalCase[] = [
        ...(EVAL_SETS[clientId]?.retrieval ?? []),
        ...(await store.listTurns(clientId, { status: 'approved', limit: 1000 }))
          .filter((t) => (t.uses as string[]).includes('retrieval_eval') && t.split === 'eval')
          .map((t) => ({ q: t.customerText, source: ((t.provenance as { expectedSource?: string | null }).expectedSource ?? null) as string | null, channel: t.channel as 'voice' | 'chat' })),
      ];
      const gapCases: RetrievalCase[] = gapQuestions.map((q) => ({ q, source: newSource, channel: 'chat' }));
      const liveBase: RankedCase[] = await rankCases(searcher, clientId, base);
      const candBase: RankedCase[] = await rankCases(searcher, ns, base);
      const candGap: RankedCase[] = await rankCases(searcher, ns, gapCases);
      const liveGap: RankedCase[] = await rankCases(searcher, clientId, gapCases);
      const cfg = searcher.config;
      const before = scoreRetrieval(liveBase, cfg);
      const after = scoreRetrieval(candBase, cfg);
      const gapAfter = scoreRetrieval(candGap, cfg);
      const gapBefore = scoreRetrieval(liveGap, cfg);
      // Unsupported questions that the new document now answers: expected only when they are the gap's own.
      const foreign = new Set(
        Object.entries(EVAL_SETS).filter(([id]) => id !== clientId).flatMap(([, s]) => s.retrieval.map((r) => r.source)).filter((s): s is string => !!s),
      );
      const leaks = scoreRetrieval(candBase, cfg, foreign).leaks;
      const answeredGap = candGap.filter(({ set }) => {
        const d = decide(set.ranked, cfg);
        return d.relevant && d.passages.slice(0, 3).some((x) => stem(toCitation(x, d.weak).source) === newSource);
      }).length;
      const warnings = built?.warnings ?? [];
      const gates: Gate[] = [];
      const add = (name: string, v: 'pass' | 'fail' | 'inconclusive', detail: string) => gates.push({ name, pass: v === 'pass', verdict: v, detail });
      const att = p.attestation as { sourceType?: string; owner?: string; reference?: string };
      add('source is an approved document or a policy owner', att.owner && att.reference ? 'pass' : 'fail', `${att.sourceType ?? '?'}: ${att.owner ?? '?'}, ${att.reference ?? '?'}`);
      add('candidate index built', built?.status === 'ready' && (built.chunks ?? 0) > 0 ? 'pass' : 'fail', built ? `${built.status}, ${built.chunks} sections, ${built.pages ?? '?'} pages${built.ocrPages ? `, ${built.ocrPages} read by OCR` : ''}${built.error ? `: ${built.error.message}` : ''}` : 'did not finish');
      add('document has no instruction-like text', warnings.some((w) => /instruction/i.test(w)) ? 'inconclusive' : 'pass', warnings.length ? warnings.slice(0, 2).join(' | ') : 'no notes');
      add(
        'the gap\'s questions are now answered from the new document',
        gapQuestions.length < 2 ? 'inconclusive' : answeredGap / gapQuestions.length >= 0.6 ? 'pass' : 'fail',
        gapQuestions.length < 2 ? 'fewer than 2 example questions to test with' : `${answeredGap} of ${gapQuestions.length} (before: ${Math.round(gapBefore.recallAt3 * gapQuestions.length)})`,
      );
      add('right passage for existing questions (recall@3) does not drop', after.recallAt3 >= before.recallAt3 - 1e-9 ? 'pass' : 'fail', `${(before.recallAt3 * 100).toFixed(1)}% to ${(after.recallAt3 * 100).toFixed(1)}%`);
      add('citation accuracy does not drop', after.citationAccuracy >= before.citationAccuracy - 1e-9 ? 'pass' : 'fail', `${(before.citationAccuracy * 100).toFixed(1)}% to ${(after.citationAccuracy * 100).toFixed(1)}%`);
      add('questions the documents do not cover are still refused', after.unsupportedRefused >= before.unsupportedRefused - 1e-9 ? 'pass' : 'fail', `${(before.unsupportedRefused * 100).toFixed(1)}% to ${(after.unsupportedRefused * 100).toFixed(1)}%${after.unsupportedRefused < before.unsupportedRefused ? ' (the new document answers a question the fixtures expected to be unanswered; check it is intended)' : ''}`);
      add('answerable questions not refused more often', after.wronglyRefused <= before.wronglyRefused + 1e-9 ? 'pass' : 'fail', `${(before.wronglyRefused * 100).toFixed(1)}% to ${(after.wronglyRefused * 100).toFixed(1)}%`);
      add('no other company\'s documents returned', leaks === 0 ? 'pass' : 'fail', `${leaks} foreign passages`);
      const enough = after.answerable >= 4 && after.unsupported >= 2;
      add('enough evaluation questions', enough ? 'pass' : 'inconclusive', `${after.answerable} answerable, ${after.unsupported} unsupported`);
      const failed = gates.some((g) => g.verdict === 'fail');
      const evaluation: Evaluation = {
        passed: gates.every((g) => g.pass),
        ...(!failed && gates.some((g) => g.verdict === 'inconclusive') ? { inconclusive: true } : {}),
        gates,
        metrics: { candidate: after, gapAfter, copiedChunks: copied, candidateChunks: built?.chunks ?? 0, answeredGap, gapQuestions: gapQuestions.length },
        baseline: { ...before, gapBefore },
        evaluatedAt: new Date().toISOString(),
      };
      return (await ml.updateProposal(clientId, p.id, { status: 'evaluated', evaluation, reviewer: by }))!;
    } catch (err) {
      logger.error({ err: String(err), proposal: p.id }, 'candidate index failed');
      return (await ml.updateProposal(clientId, p.id, { status: 'failed', note: String(err).slice(0, 300) }))!;
    } finally {
      await knowledgeRepo.deleteNamespace(deps.db, ns).catch(() => undefined);
      await knowledge.remove(ns, p.docName!).catch(() => undefined);
    }
  }

  // ---- 4. approve, publish, roll back ----------------------------------------------------------

  async function approve(clientId: string, proposalId: string, by: string): Promise<ProposalRow> {
    const p = await ml.getProposal(clientId, proposalId);
    if (!p) throw new KnowledgeChangeError('NOT_FOUND', 'Proposal not found');
    const ev = p.evaluation as Partial<Evaluation>;
    if (p.status !== 'evaluated' || ev.passed === undefined) throw new KnowledgeChangeError('NOT_EVALUATED', 'Build and evaluate the candidate index first');
    if (!ev.passed) {
      const failed = (ev.gates ?? []).filter((g) => !g.pass).map((g) => g.name);
      throw new KnowledgeChangeError('GATES_FAILED', `Not approved: ${ev.inconclusive ? 'inconclusive' : 'failed'} ${failed.join(', ')}`);
    }
    return (await ml.updateProposal(clientId, p.id, { status: 'approved', reviewer: by }))!;
  }

  async function reject(clientId: string, proposalId: string, by: string, note?: string): Promise<ProposalRow> {
    const p = await ml.getProposal(clientId, proposalId);
    if (!p) throw new KnowledgeChangeError('NOT_FOUND', 'Proposal not found');
    if (p.status === 'deployed') throw new KnowledgeChangeError('INVALID', 'Roll a deployed change back instead of rejecting it');
    return (await ml.updateProposal(clientId, p.id, { status: 'rejected', reviewer: by, note: note ?? null }))!;
  }

  async function deploy(clientId: string, proposalId: string, by: string): Promise<{ proposal: ProposalRow; releaseId: string }> {
    const p = await ml.getProposal(clientId, proposalId);
    if (!p) throw new KnowledgeChangeError('NOT_FOUND', 'Proposal not found');
    if (p.status !== 'approved') throw new KnowledgeChangeError('NOT_APPROVED', 'Only an approved proposal can be published');
    const bytes = await readFile(p.filePath!);
    if (createHash('sha256').update(bytes).digest('hex') !== p.fileSha256)
      throw new KnowledgeChangeError('FAILED', 'The stored file no longer matches the one that was evaluated');
    const live = (await knowledge.list(clientId)).find((d) => d.source === p.docName && d.status === 'ready');
    // The normal versioned upload builds the new version beside the live one and swaps it in one step.
    const up = await knowledge.upload(clientId, p.docName!, bytes);
    const done = await knowledge.waitUntilSettled(clientId, up.document.id!, buildTimeout);
    if (!done || done.status !== 'ready') {
      await ml.updateProposal(clientId, p.id, { status: 'failed', note: `Publishing failed: ${done?.error?.message ?? 'did not finish'}. The live version is unchanged.` });
      throw new KnowledgeChangeError('FAILED', 'The new version did not finish building; the live version is unchanged');
    }
    const version = await releaseVersion(clientId);
    const release = await deps.store.insertRelease({
      clientId,
      kind: 'knowledge',
      channel: 'both',
      version,
      params: { rollout: 100, config: { proposalId: p.id, docName: p.docName, newDocumentId: done.id, previousDocumentId: live?.id ?? null, previousVersion: live?.version ?? null } },
      evaluation: p.evaluation as Record<string, unknown>,
      status: 'active',
      note: `${p.title} (approved by ${by})`,
      createdBy: by,
      deployedAt: new Date(),
    });
    const proposal = (await ml.updateProposal(clientId, p.id, { status: 'deployed', releaseId: release.id, reviewer: by }))!;
    deps.releases.invalidate();
    logger.info({ clientId, doc: p.docName, version: done.version, by }, 'knowledge change published');
    return { proposal, releaseId: release.id };
  }

  const releaseVersion = (clientId: string) => deps.store.nextReleaseVersion(clientId, 'knowledge', 'both');

  /** Restores the document as it was before: the previous version is published again, or the document is removed if it was new. */
  async function rollback(clientId: string, proposalId: string, by: string): Promise<ProposalRow> {
    const p = await ml.getProposal(clientId, proposalId);
    if (!p) throw new KnowledgeChangeError('NOT_FOUND', 'Proposal not found');
    if (p.status !== 'deployed' || !p.releaseId) throw new KnowledgeChangeError('INVALID', 'Only a published change can be rolled back');
    const rel = await deps.store.getRelease(clientId, p.releaseId);
    const cfg = (rel?.params as { config?: { previousDocumentId?: string | null } } | undefined)?.config;
    if (cfg?.previousDocumentId) {
      const old = await knowledge.bytesOf(clientId, cfg.previousDocumentId);
      if (!old) throw new KnowledgeChangeError('FAILED', 'The previous version\'s file is no longer stored, so it cannot be restored');
      const up = await knowledge.upload(clientId, p.docName!, old);
      const done = await knowledge.waitUntilSettled(clientId, up.document.id!, buildTimeout);
      if (!done || done.status !== 'ready') throw new KnowledgeChangeError('FAILED', 'Restoring the previous version did not finish; check the Knowledge page');
    } else {
      await knowledge.remove(clientId, p.docName!);
    }
    await deps.store.setReleaseStatus(clientId, p.releaseId, { status: 'rolled_back', note: `${rel?.note ?? ''} | rolled back by ${by}` });
    deps.releases.invalidate();
    return (await ml.updateProposal(clientId, p.id, { status: 'rolled_back', reviewer: by }))!;
  }

  return { diagnose, propose, evaluate, approve, reject, deploy, rollback };
}

export type KnowledgeChange = ReturnType<typeof createKnowledgeChange>;
