import { Router } from 'express';
import type { EvalRunView } from '@adk/shared';
import { HttpError } from '../middleware';

export interface EvalService {
  /** Starts a run in the background and returns its id immediately. */
  start(clientId: string): Promise<string>;
  get(runId: string): Promise<EvalRunView | undefined>;
  list(clientId: string): Promise<EvalRunView[]>;
}

export function testsRouter(evals: EvalService): Router {
  const router = Router();

  router.post('/tests/run', async (req, res) => {
    const clientId = (req.body as { clientId?: unknown } | undefined)?.clientId;
    if (typeof clientId !== 'string') throw new HttpError(400, 'INVALID_REQUEST', 'clientId is required');
    res.status(202).json({ data: { runId: await evals.start(clientId) } });
  });

  router.get('/tests/runs', async (req, res) => {
    const clientId = req.query.clientId;
    if (typeof clientId !== 'string') throw new HttpError(400, 'INVALID_REQUEST', 'clientId is required');
    res.json({ data: await evals.list(clientId) });
  });

  router.get('/tests/runs/:id', async (req, res) => {
    const run = await evals.get(String(req.params.id));
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'No such run');
    res.json({ data: run });
  });

  return router;
}
