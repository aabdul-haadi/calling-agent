import { z } from 'zod';
import { ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { fetchOwnedBooking, flightSchema, refSchema } from './api';

export const search_alternatives_output = z.array(flightSchema);

export const searchAlternatives = defineTool({
  name: 'search_alternatives',
  description:
    'Find up to 3 alternative flights on the same route for a verified passenger booking. Only flights returned here may be offered or booked.',
  input: z.object({ bookingRef: refSchema }),
  label: 'Searched for alternative flights',
  async run({ bookingRef }, ctx) {
    const booking = await fetchOwnedBooking(bookingRef, ctx);
    if (!booking.ok) return booking;
    // Route and date come from the booking, never from the model, so it cannot search elsewhere.
    const res = await ctx.api.request({
      path: 'flights/alternatives',
      query: {
        origin: booking.data.flight.origin,
        destination: booking.data.flight.destination,
        after: booking.data.flight.departure,
      },
      schema: search_alternatives_output,
    });
    if (!res.ok) return res;
    const alternatives = res.data
      .filter((f) => f.id !== booking.data.flight.id)
      .slice(0, 3)
      .map((f) => ({
        flightId: f.id,
        flightNumber: f.flightNumber,
        departure: f.departure,
        arrival: f.arrival,
        seatsLeft: f.seatsLeft,
      }));
    return ok({ alternatives });
  },
  summarize: (d) =>
    `Found ${d.alternatives.length} alternative flight${d.alternatives.length === 1 ? '' : 's'}`,
  remember: (data) => ({ collected: { alternatives: data.alternatives }, step: 'offer' }),
});
