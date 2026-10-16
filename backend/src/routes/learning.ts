import { timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import type { Env } from '../config';
import { HttpError, rateLimit } from '../middleware';
import { ReleaseError, ReviewError, type LearningService } from '../learning';
import { KnowledgeChangeError } from '../learning/knowledge-change';
import { ModelReleaseError } from '../learning/ml-service';
import { TrainingError } from '../learning/training';

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'bad id');
const reviewBody = z.object({
  decision: z.enum(['approve', 'reject', 'exclude']),
  note: z.string().max(500).optional(),
  approvedReply: z.string().max(2000).optional(),
  uses: z.array(z.enum(['sft', 'retrieval_eval', 'behavior', 'intent'])).max(4).optional(),
  expectedSource: z.string().max(200).nullable().optional(),
  intent: z.string().max(80).optional(),
});
const behaviorBody = z.object({
  channel: z.enum(['voice', 'chat', 'both']).default('both'),
  styleLines: z.array(z.string().max(200)).max(8).optional(),
  avoidOpeners: z.array(z.string().max(60)).max(12).optional(),
  rollout: z.number().int().min(0).max(100).optional(),
  evaluateLive: z.boolean().optional(),
});
const rollbackBody = z.object({
  kind: z.enum(['retrieval', 'behavior', 'intent_model', 'llm_adapter']),
  channel: z.enum(['voice', 'chat', 'both']).default('both'),
});
const feedbackBody = z.object({
  clientId: z.string().min(1),
  conversationId: uuid,
  rating: z.number().int().min(1).max(5).optional(),
  correction: z.string().trim().max(1000).optional(),
});

/**
 * The learning console's API. Everything is scoped to one company in the URL. If LEARNING_REVIEW_TOKEN
 * is set, every console route needs it as a bearer token; the customer feedback route never does and
 * can only add a rating or a suggested correction to the conversation's own latest turn (unapproved).
 */
export function learningRouter(env: Env, registry: ClientRegistry, learning: LearningService): Router {
  const router = Router();

  const known = (id: string | undefined): string => {
    if (!id || !registry.get(id)) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    return id;
  };
  const authorize = (req: Request): string => {
    const token = env.LEARNING_REVIEW_TOKEN;
    if (token) {
      const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new HttpError(401, 'UNAUTHORIZED', 'The learning console needs the review token');
    }
    const who = (req.header('x-reviewer') ?? '').trim().slice(0, 60);
    return who || 'console';
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, 'INVALID_REQUEST', r.error.issues[0]?.message ?? 'Invalid request');
    return r.data;
  };
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ReviewError)
        throw new HttpError(err.code === 'NOT_FOUND' ? 404 : 400, err.code, err.message);
      if (err instanceof TrainingError)
        throw new HttpError(err.code === 'NOT_FOUND' ? 404 : err.code === 'BUSY' ? 409 : 400, err.code, err.message);
      if (err instanceof ModelReleaseError)
        throw new HttpError(err.code === 'NOT_FOUND' ? 404 : err.code === 'LOCAL_MODEL_DOWN' ? 503 : 409, err.code, err.message);
      if (err instanceof KnowledgeChangeError)
        throw new HttpError(err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID' ? 400 : 409, err.code, err.message);
      if (err instanceof ReleaseError)
        throw new HttpError(err.code === 'NOT_FOUND' ? 404 : 409, err.code, err.message);
      throw err;
    }
  };
  const base = '/clients/:id/learning';

  router.get(`${base}/overview`, async (req, res) => {
    authorize(req);
    res.json({ data: await guard(() => learning.overview(known(req.params.id))) });
  });

  router.get(`${base}/turns`, async (req, res) => {
    authorize(req);
    const clientId = known(req.params.id);
    const status = ['pending', 'approved', 'rejected', 'excluded'].includes(String(req.query.status))
      ? (String(req.query.status) as 'pending' | 'approved' | 'rejected' | 'excluded')
      : undefined;
    const flag = typeof req.query.flag === 'string' && /^[a-z_]{1,40}$/.test(req.query.flag) ? req.query.flag : undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ data: await learning.store.listTurns(clientId, { ...(status ? { status } : {}), ...(flag ? { flag } : {}), limit }) });
  });

  router.post(`${base}/turns/:turnId/review`, async (req, res) => {
    const reviewer = authorize(req);
    const clientId = known(req.params.id);
    const body = parse(reviewBody, req.body);
    const turnId = parse(uuid, req.params.turnId);
    res.json({ data: await guard(() => learning.review(clientId, turnId, { ...body, reviewer })) });
  });

  router.get(`${base}/gaps`, async (req, res) => {
    authorize(req);
    res.json({ data: await learning.store.listGaps(known(req.params.id)) });
  });
  router.post(`${base}/gaps/:gapId/status`, async (req, res) => {
    authorize(req);
    const body = parse(z.object({ status: z.enum(['open', 'covered_by_document', 'document_requested', 'dismissed']), note: z.string().max(500).optional() }), req.body);
    const row = await learning.store.setGapStatus(known(req.params.id), parse(uuid, req.params.gapId), body.status, body.note);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'No such gap');
    res.json({ data: row });
  });

  router.get(`${base}/datasets`, async (req, res) => {
    authorize(req);
    res.json({ data: await learning.store.listDatasets(known(req.params.id)) });
  });
  router.post(`${base}/datasets`, async (req, res) => {
    authorize(req);
    const body = parse(z.object({ channel: z.enum(['voice', 'chat']).optional() }), req.body ?? {});
    res.status(201).json({ data: await guard(() => learning.buildDataset(known(req.params.id), body.channel)) });
  });
  router.get(`${base}/datasets/:dsId/download`, async (req, res) => {
    authorize(req);
    const text = await guard(() => learning.renderDataset(known(req.params.id), parse(uuid, req.params.dsId)));
    res.type('application/x-ndjson').send(text);
  });

  router.get(`${base}/releases`, async (req, res) => {
    authorize(req);
    res.json({ data: await learning.store.listReleases(known(req.params.id)) });
  });
  router.post(`${base}/releases/behavior`, async (req, res) => {
    const by = authorize(req);
    const body = parse(behaviorBody, req.body ?? {});
    res.status(201).json({ data: await guard(() => learning.proposeBehavior(known(req.params.id), body.channel, by, body)) });
  });
  router.post(`${base}/releases/retrieval/tune`, async (req, res) => {
    const by = authorize(req);
    res.status(201).json({ data: await guard(() => learning.proposeRetrieval(known(req.params.id), by)) });
  });
  router.post(`${base}/models/intent/train`, async (req, res) => {
    const by = authorize(req);
    const { release } = await guard(() => learning.trainIntentModel(known(req.params.id), by));
    res.status(201).json({ data: release });
  });
  router.post(`${base}/releases/:rid/evaluate`, async (req, res) => {
    authorize(req);
    res.json({ data: await guard(() => learning.evaluateRelease(known(req.params.id), parse(uuid, req.params.rid))) });
  });
  router.post(`${base}/releases/:rid/shadow`, async (req, res) => {
    authorize(req);
    res.json({ data: await guard(() => learning.releases.startShadow(known(req.params.id), parse(uuid, req.params.rid))) });
  });
  router.post(`${base}/releases/:rid/deploy`, async (req, res) => {
    const by = authorize(req);
    res.json({ data: await guard(() => learning.deploy(known(req.params.id), parse(uuid, req.params.rid), by)) });
  });
  router.post(`${base}/releases/:rid/reject`, async (req, res) => {
    const by = authorize(req);
    const body = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    res.json({ data: await guard(() => learning.releases.reject(known(req.params.id), parse(uuid, req.params.rid), by, body.note)) });
  });
  router.post(`${base}/releases/rollback`, async (req, res) => {
    const by = authorize(req);
    const body = parse(rollbackBody, req.body);
    res.json({ data: await guard(() => learning.rollback(known(req.params.id), body.kind, body.channel, by)) });
  });

  router.get(`${base}/jobs`, async (req, res) => {
    authorize(req);
    res.json({ data: await learning.store.listJobs(known(req.params.id)) });
  });
  router.post(`${base}/cycle`, async (req, res) => {
    authorize(req);
    res.status(202).json({ data: await guard(() => learning.runCycle(known(req.params.id), 'manual')) });
  });

  router.delete(`${base}/conversations/:cid`, async (req, res) => {
    authorize(req);
    const removed = await learning.purgeConversation(known(req.params.id), parse(uuid, req.params.cid));
    res.json({ data: { removed } });
  });

  // ---- local model training ------------------------------------------------------------------
  const wf = learning.workflows;
  const trainingBody = z.object({
    datasetId: uuid.optional(),
    smoke: z.boolean().optional(),
    config: z
      .object({
        base: z.string().max(120).regex(/^[\w./-]+$/).optional(),
        epochs: z.number().min(0.1).max(10).optional(),
        seed: z.number().int().optional(),
        lr: z.number().min(1e-6).max(1e-2).optional(),
        rank: z.number().int().min(1).max(64).optional(),
        maxLen: z.number().int().min(64).max(4096).optional(),
        batch: z.number().int().min(1).max(16).optional(),
        accum: z.number().int().min(1).max(64).optional(),
        valFraction: z.number().min(0).max(0.5).optional(),
        maxSteps: z.number().int().min(0).max(100000).optional(),
        threads: z.number().int().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  });
  router.get(`${base}/training/hardware`, async (req, res) => {
    authorize(req);
    known(req.params.id);
    const b = typeof req.query.base === 'string' && /^[\w./-]{1,120}$/.test(req.query.base) ? req.query.base : undefined;
    res.json({ data: await wf.hardware(b) });
  });
  router.get(`${base}/training/runs`, async (req, res) => {
    authorize(req);
    res.json({ data: await wf.ml.listRuns(known(req.params.id)) });
  });
  router.post(`${base}/training/runs`, async (req, res) => {
    const by = authorize(req);
    const body = parse(trainingBody, req.body ?? {});
    const run = await guard(() =>
      wf.training.start(known(req.params.id), { datasetId: body.datasetId, smoke: body.smoke === true, config: body.config ?? {}, by }),
    );
    res.status(202).json({ data: run });
  });
  router.post(`${base}/training/runs/:runId/cancel`, async (req, res) => {
    authorize(req);
    res.json({ data: await guard(() => wf.training.cancel(known(req.params.id), parse(uuid, req.params.runId))) });
  });
  router.post(`${base}/training/runs/:runId/resume`, async (req, res) => {
    const by = authorize(req);
    res.status(202).json({ data: await guard(() => wf.training.resume(known(req.params.id), parse(uuid, req.params.runId), by)) });
  });

  // ---- candidate models: compare, shadow, promote --------------------------------------------
  router.post(`${base}/models/:rid/evaluate`, async (req, res) => {
    authorize(req);
    const body = parse(z.object({ latencyApproved: z.boolean().optional() }), req.body ?? {});
    res.json({ data: await guard(() => wf.evaluateModel(known(req.params.id), parse(uuid, req.params.rid), body)) });
  });
  router.post(`${base}/models/:rid/shadow`, async (req, res) => {
    authorize(req);
    res.json({ data: await guard(() => wf.startShadow(known(req.params.id), parse(uuid, req.params.rid))) });
  });
  router.get(`${base}/models/:rid/shadow`, async (req, res) => {
    authorize(req);
    res.json({ data: await wf.shadowReport(known(req.params.id), parse(uuid, req.params.rid)) });
  });
  router.post(`${base}/models/:rid/promote`, async (req, res) => {
    const by = authorize(req);
    res.json({ data: await guard(() => wf.promoteModel(known(req.params.id), parse(uuid, req.params.rid), by)) });
  });

  // ---- knowledge changes: diagnose, propose, build a candidate index, approve, publish, roll back
  const kc = () => {
    if (!wf.knowledgeChange) throw new HttpError(503, 'UNAVAILABLE', 'The knowledge service is not available');
    return wf.knowledgeChange;
  };
  router.get(`${base}/knowledge/gaps/:gapId/diagnosis`, async (req, res) => {
    authorize(req);
    const clientId = known(req.params.id);
    const gap = (await learning.store.listGaps(clientId)).find((g) => g.id === parse(uuid, req.params.gapId));
    if (!gap) throw new HttpError(404, 'NOT_FOUND', 'No such gap');
    res.json({ data: await guard(() => kc().diagnose(clientId, gap)) });
  });
  router.get(`${base}/knowledge/proposals`, async (req, res) => {
    authorize(req);
    res.json({ data: await wf.ml.listProposals(known(req.params.id)) });
  });
  router.post(
    `${base}/knowledge/proposals`,
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: 100 * 1024 * 1024 }),
    async (req, res) => {
      const by = authorize(req);
      const clientId = known(req.params.id);
      const q = parse(
        z.object({
          title: z.string().min(3).max(160),
          docName: z.string().min(5).max(120),
          gapId: uuid.optional(),
          sourceType: z.string().max(40),
          owner: z.string().max(120),
          reference: z.string().max(200),
        }),
        req.query,
      );
      if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'UNSUPPORTED_TYPE', 'Send the PDF as the request body (Content-Type: application/pdf).');
      const bytes = req.body;
      const row = await guard(() =>
        kc().propose(clientId, { gapId: q.gapId, title: q.title, docName: q.docName, bytes, attestation: { sourceType: q.sourceType, owner: q.owner, reference: q.reference }, by }),
      );
      res.status(201).json({ data: row });
    },
  );
  router.post(`${base}/knowledge/proposals/:pid/evaluate`, async (req, res) => {
    const by = authorize(req);
    res.status(202).json({ data: await guard(() => kc().evaluate(known(req.params.id), parse(uuid, req.params.pid), by)) });
  });
  router.post(`${base}/knowledge/proposals/:pid/approve`, async (req, res) => {
    const by = authorize(req);
    res.json({ data: await guard(() => kc().approve(known(req.params.id), parse(uuid, req.params.pid), by)) });
  });
  router.post(`${base}/knowledge/proposals/:pid/reject`, async (req, res) => {
    const by = authorize(req);
    const body = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    res.json({ data: await guard(() => kc().reject(known(req.params.id), parse(uuid, req.params.pid), by, body.note)) });
  });
  router.post(`${base}/knowledge/proposals/:pid/deploy`, async (req, res) => {
    const by = authorize(req);
    res.json({ data: await guard(() => kc().deploy(known(req.params.id), parse(uuid, req.params.pid), by)) });
  });
  router.post(`${base}/knowledge/proposals/:pid/rollback`, async (req, res) => {
    const by = authorize(req);
    res.json({ data: await guard(() => kc().rollback(known(req.params.id), parse(uuid, req.params.pid), by)) });
  });

  // Customers can say how it went. The text is redacted, stored unapproved, and changes nothing by itself.
  router.post('/feedback', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
    const body = parse(feedbackBody, req.body);
    known(body.clientId);
    const ok = await learning.capture.recordFeedback(body.clientId, body.conversationId, {
      rating: body.rating,
      correction: body.correction,
    });
    res.status(ok ? 201 : 404).json(ok ? { data: { ok: true } } : { error: { code: 'NOT_FOUND', message: 'Nothing to attach feedback to yet' } });
  });

  return router;
}
