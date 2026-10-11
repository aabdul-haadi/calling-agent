import { z } from 'zod';
import { fail, ok, type ToolResult } from '@adk/shared';
import type { ToolContext } from '@backend/tools/types';

// Shapes of the SkyLink company API. Every response is validated against these before use.
export const flightSchema = z.object({
  id: z.string(),
  flightNumber: z.string(),
  origin: z.string(),
  destination: z.string(),
  departure: z.string(),
  arrival: z.string(),
  seatsLeft: z.number(),
  status: z.enum(['SCHEDULED', 'CANCELLED']),
});
export type Flight = z.infer<typeof flightSchema>;

export const bookingSchema = z.object({
  ref: z.string(),
  passengerId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  fareClass: z.enum(['ECONOMY', 'FLEX', 'BUSINESS']),
  changesMade: z.number(),
  flight: flightSchema,
});
export type BookingRecord = z.infer<typeof bookingSchema>;

// People type "SK 1001" or "SK-1001": spaces and hyphens are accepted and removed by normalizeRef.
export const refSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,14}[A-Za-z0-9]$/, 'booking reference looks like SK1001')
  .refine((v) => /^[A-Za-z0-9]{4,10}$/.test(v.replace(/[\s-]/g, '')), {
    message: 'booking reference is letters and digits only, e.g. SK1001',
  });

export const normalizeRef = (ref: string) => ref.replace(/[\s-]/g, '').toUpperCase();

export async function fetchBooking(
  ref: string,
  ctx: ToolContext,
): Promise<ToolResult<BookingRecord>> {
  return ctx.api.request({
    path: `bookings/${encodeURIComponent(normalizeRef(ref))}`,
    schema: bookingSchema,
  });
}

/** A verified customer may only touch their OWN bookings, even if they know someone else's ref. */
export async function fetchOwnedBooking(
  ref: string,
  ctx: ToolContext,
): Promise<ToolResult<BookingRecord>> {
  const res = await fetchBooking(ref, ctx);
  if (!res.ok) return res;
  if (res.data.passengerId !== ctx.state.customerId) {
    return fail('UNAUTHORIZED', 'That booking does not belong to the verified customer.');
  }
  return ok(res.data);
}
