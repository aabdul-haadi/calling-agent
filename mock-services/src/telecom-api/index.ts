import { Router } from 'express';
import { buildTelecomSeed } from '../seed-data/telecom';
import { createAuth, sendError, simulate, type MockOptions } from '../common';

export function createTelecomApi(opts: MockOptions): Router {
  const seed = buildTelecomSeed();
  const accounts = new Map(seed.accounts.map((a) => [a.id, a]));
  const bills = new Map(seed.bills.map((b) => [b.accountId, b]));

  const { tokenRouter, requireToken } = createAuth(opts);
  const router = Router();
  router.use(tokenRouter);
  router.use(requireToken, simulate(opts));

  router.get('/accounts/:id', (req, res) => {
    const account = accounts.get(req.params.id ?? '');
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'No such account');
    res.json({ data: account });
  });

  router.get('/accounts/:id/bills/latest', (req, res) => {
    const bill = bills.get(req.params.id ?? '');
    if (!bill) return sendError(res, 404, 'BILL_NOT_FOUND', 'No bill for this account');
    res.json({ data: bill });
  });

  router.get('/outages', (req, res) => {
    const area = String(req.query.area ?? '')
      .trim()
      .toLowerCase();
    if (!area) return sendError(res, 400, 'MISSING_PARAMS', 'area is required');
    const outage = seed.outages.find((o) => o.area.toLowerCase() === area);
    if (!outage) return sendError(res, 404, 'AREA_NOT_FOUND', 'Unknown coverage area');
    res.json({ data: outage });
  });

  return router;
}
