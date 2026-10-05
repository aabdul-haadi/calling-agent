import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { accountIdSchema, billSchema, normalizeId } from './api';

export const getBill = defineTool({
  name: 'get_bill',
  description:
    "Get the verified customer's latest bill with its line items and the change from the previous month. Use it to explain why a bill is higher or when it is due.",
  input: z.object({ accountId: accountIdSchema }),
  label: 'Checked the billing system',
  async run({ accountId }, ctx) {
    const id = normalizeId(accountId);
    // A verified customer may only read their OWN bill.
    if (id !== ctx.state.customerId)
      return fail('UNAUTHORIZED', 'That account does not belong to the verified customer.');
    const res = await ctx.api.request({
      path: `accounts/${encodeURIComponent(id)}/bills/latest`,
      schema: billSchema,
    });
    if (!res.ok) return res;
    const b = res.data;
    return ok({
      period: b.period,
      total: b.total,
      previousTotal: b.previousTotal,
      change: Math.round((b.total - b.previousTotal) * 100) / 100,
      dueDate: b.dueDate,
      status: b.status,
      lineItems: b.lineItems,
    });
  },
  summarize: (d) =>
    d.change > 0
      ? `Bill is $${d.change} higher than last month`
      : 'Bill is unchanged from last month',
  remember: (data) => ({ collected: { bill: data }, step: 'explain' }),
});
