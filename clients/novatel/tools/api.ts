import { z } from 'zod';

// Shapes of the NovaTel company API. Every response is validated before use.
export const accountSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  area: z.string(),
  plan: z.object({ name: z.string(), monthlyPrice: z.number(), dataGb: z.number() }),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export const billSchema = z.object({
  accountId: z.string(),
  period: z.string(),
  lineItems: z.array(z.object({ label: z.string(), amount: z.number() })),
  total: z.number(),
  previousTotal: z.number(),
  dueDate: z.string(),
  status: z.enum(['PAID', 'DUE', 'OVERDUE']),
});

export const outageSchema = z.object({
  area: z.string(),
  status: z.enum(['OK', 'DEGRADED', 'OUTAGE']),
  message: z.string(),
  etaRestored: z.string().optional(),
});

// People type "NT 2001" or "NT-2001": spaces and hyphens are accepted and removed by normalizeId.
export const accountIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,14}[A-Za-z0-9]$/, 'account number looks like NT2001')
  .refine((v) => /^[A-Za-z0-9]{4,10}$/.test(v.replace(/[\s-]/g, '')), {
    message: 'account number is letters and digits only, e.g. NT2001',
  });

export const normalizeId = (id: string) => id.replace(/[\s-]/g, '').toUpperCase();
