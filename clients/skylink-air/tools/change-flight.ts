import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { buildIdempotencyKey, withIdempotency } from '@backend/tools/security';
import { bookingSchema, fetchOwnedBooking, normalizeRef, refSchema } from './api';
import { summarizeBooking } from './get-booking';

const offered = z.array(z.object({ flightId: z.string() }));

// One free voluntary change per booking. Airline-cancelled flights can always be rebooked free.
const FREE_VOLUNTARY_CHANGES = 1;

export const changeFlight = defineTool({
  name: 'change_flight',
  description:
    'Move the passenger to one of the alternative flights that search_alternatives returned. ONLY call after the customer has clearly said yes to that specific flight.',
  input: z.object({
    bookingRef: refSchema,
    newFlightId: z.string().min(3).max(40),
    customerConfirmed: z.literal(true, { error: 'the customer must explicitly confirm first' }),
  }),
  label: 'Rebooked the flight',
  async run({ bookingRef, newFlightId }, ctx) {
    const ref = normalizeRef(bookingRef);
    const offeredFlights = offered.safeParse(ctx.state.collected.alternatives);
    if (!offeredFlights.success || !offeredFlights.data.some((f) => f.flightId === newFlightId)) {
      return fail('RULE_BLOCKED', 'That flight was not one of the options offered. Search alternatives first.');
    }
    const booking = await fetchOwnedBooking(ref, ctx);
    if (!booking.ok) return booking;
    const cancelled = booking.data.flight.status === 'CANCELLED';
    if (!cancelled && booking.data.changesMade >= FREE_VOLUNTARY_CHANGES) {
      return fail('RULE_BLOCKED', 'The free change for this booking has been used; a fee would apply. Offer a human agent.');
    }

    // Same conversation + booking + flight => same key => the API replays instead of double-booking.
    const key = buildIdempotencyKey(ctx.conversationId, ref, newFlightId);
    return withIdempotency(ctx.idempotency, key, async () => {
      const res = await ctx.api.request({
        method: 'POST',
        path: `bookings/${encodeURIComponent(ref)}/change`,
        body: { newFlightId },
        headers: { 'Idempotency-Key': key },
        schema: bookingSchema,
      });
      return res.ok ? ok(summarizeBooking(res.data)) : res;
    });
  },
  summarize: (d) => `Now on ${d.flightNumber}`,
  remember: (data) => ({ collected: { booking: data, rebooked: true }, step: 'act' }),
});
