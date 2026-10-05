import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { accountIdSchema, accountSchema, normalizeId } from './api';

export const verifyCustomer = defineTool({
  name: 'verify_customer',
  description:
    'Verify the customer with their account number and the last name on the account. Must succeed before get_bill.',
  input: z.object({ accountId: accountIdSchema, lastName: z.string().trim().min(1).max(60) }),
  label: 'Checked identity',
  async run({ accountId, lastName }, ctx) {
    const res = await ctx.api.request({
      path: `accounts/${encodeURIComponent(normalizeId(accountId))}`,
      schema: accountSchema,
    });
    if (!res.ok) {
      // Same answer for "no such account" and "wrong name": do not reveal which accounts exist.
      return res.error === 'NOT_FOUND'
        ? fail('UNAUTHORIZED', 'Those details do not match our records.')
        : res;
    }
    if (res.data.lastName.trim().toLowerCase() !== lastName.trim().toLowerCase()) {
      return fail('UNAUTHORIZED', 'Those details do not match our records.');
    }
    return ok({
      id: res.data.id,
      firstName: res.data.firstName,
      area: res.data.area,
      plan: res.data.plan.name,
    });
  },
  summarize: () => 'Identity verified',
  remember: (data) => ({
    verified: true,
    customerId: data.id,
    collected: {
      customerFirstName: data.firstName,
      accountId: data.id,
      area: data.area,
      plan: data.plan,
    },
    step: 'verify',
  }),
});
