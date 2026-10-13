import express, { Router } from 'express';
import { z } from 'zod';
import type { ClientRegistry } from '../clients';
import type { Env } from '../config';
import { HttpError } from '../middleware';
import { UploadError, type KnowledgeService } from '../knowledge/documents';
import type { Searcher } from '../knowledge/retrieve';

const searchBody = z.object({
  question: z.string().min(1).max(500),
  /** Earlier customer questions, oldest first, to test how a follow-up is understood. */
  history: z.array(z.string().max(500)).max(6).optional(),
});

/**
 * The knowledge console's API. Everything is scoped to one company in the URL; a document id from
 * another company is treated as not found.
 */
export function knowledgeRouter(
  env: Env,
  registry: ClientRegistry,
  knowledge: KnowledgeService,
  searcher: Searcher,
): Router {
  const router = Router();
  const known = (id: string | undefined): string => {
    if (!id || !registry.get(id)) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
    return id;
  };
  const maxBytes = env.KNOWLEDGE_MAX_UPLOAD_MB * 1024 * 1024;

  router.get('/clients/:id/knowledge', async (req, res) => {
    res.json({ data: await knowledge.list(known(req.params.id)) });
  });

  router.post(
    '/clients/:id/knowledge/documents',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: maxBytes }),
    async (req, res) => {
      const clientId = known(req.params.id);
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      if (!Buffer.isBuffer(req.body))
        throw new HttpError(
          415,
          'UNSUPPORTED_TYPE',
          'Send the PDF as the request body (Content-Type: application/pdf).',
        );
      try {
        const out = await knowledge.upload(clientId, name, req.body);
        res.status(out.unchanged ? 200 : 202).json({ data: out });
      } catch (err) {
        if (err instanceof UploadError) throw new HttpError(err.status, err.code, err.message);
        throw err;
      }
    },
  );

  router.get('/clients/:id/knowledge/documents/:docId', async (req, res) => {
    const doc = await knowledge.get(known(req.params.id), req.params.docId!);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Unknown document');
    res.json({ data: doc });
  });

  router.post('/clients/:id/knowledge/documents/:docId/reindex', async (req, res) => {
    const reextract = req.body?.reextract === true;
    const doc = await knowledge.reindex(known(req.params.id), req.params.docId!, { reextract });
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Unknown document');
    res.status(202).json({ data: doc });
  });

  router.post('/clients/:id/knowledge/documents/:docId/retry', async (req, res) => {
    const doc = await knowledge.retry(known(req.params.id), req.params.docId!);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Unknown document');
    res.status(202).json({ data: doc });
  });

  router.delete('/clients/:id/knowledge/documents/:docId', async (req, res) => {
    const clientId = known(req.params.id);
    const doc = await knowledge.get(clientId, req.params.docId!);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Unknown document');
    if (doc.origin === 'folder')
      throw new HttpError(
        400,
        'BUILT_IN',
        'Built-in policy files are managed in the company folder, not here.',
      );
    await knowledge.remove(clientId, doc.source);
    res.json({ data: { removed: doc.source } });
  });

  router.post('/clients/:id/knowledge/search', async (req, res) => {
    const clientId = known(req.params.id);
    const body = searchBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'BAD_REQUEST', 'Send { "question": "..." }');
    res.json({
      data: await searcher.search(clientId, body.data.question, {
        recentQuestions: body.data.history,
      }),
    });
  });

  return router;
}
