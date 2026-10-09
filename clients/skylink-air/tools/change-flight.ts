import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { buildIdempotencyKey, withIdempotency } from '@backend/tools/security';
import { bookingSchema, fetchOwnedBooking, normalizeRef, refSchema } from './api';
import { summarizeBooking } from './get-booking';

const offered = z.array(
  z.object({
    flightId: z.string(),
    flightNumber: z.string().optional(),
    departure: z.string().optional(),
  }),
);

// One free voluntary change per booking. Airline-cancelled flights can always be rebooked free.
const FREE_VOLUNTARY_CHANGES = 1;

export const changeFlight = defineTool({
  name: 'change_flight',
  description:
    'Move the passenger to one of the alternative flights that search_alternatives returned. Call it as soon as the customer picks a flight: the first call only PROPOSES the change (nothing is changed yet), then tell the customer exactly what will change and ask them to reply yes. After they say yes in a later message, call it again with the same arguments to make the change.',
  input: z.object({
    bookingRef: refSchema,
    newFlightId: z.string().min(3).max(40),
  }),
  label: 'Rebooked the flight',

  // Runs on every call, against the live booking. The customer's "yes" is only honoured while this
  // still produces the same binding as when the change was proposed.
  approval: {
    async propose({ bookingRef, newFlightId }, ctx) {
      const ref = normalizeRef(bookingRef);
      const offeredFlights = offered.safeParse(ctx.state.collected.alternatives);
      const target = offeredFlights.success
        ? offeredFlights.data.find((f) => f.flightId === newFlightId)
        : undefined;
      if (!target) {
        return fail(
          'RULE_BLOCKED',
          'That flight was not one of the options offered. Search alternatives first.',
        );
      }
      // The options must have been shown in an EARLIER reply. Searching and proposing inside one turn
      // would let the model pick a flight the customer never saw.
      const shownBefore = offered.safeParse(ctx.stateAtTurnStart.collected.alternatives);
      if (!shownBefore.success || !shownBefore.data.some((f) => f.flightId === newFlightId)) {
        return fail(
          'RULE_BLOCKED',
          'The customer has not been shown these options yet. List the alternative flights in your reply, then wait for them to choose one.',
        );
      }
      const booking = await fetchOwnedBooking(ref, ctx);
      if (!booking.ok) return booking;
      const cancelled = booking.data.flight.status === 'CANCELLED';
      if (!cancelled && booking.data.changesMade >= FREE_VOLUNTARY_CHANGES) {
        return fail(
          'RULE_BLOCKED',
          'The free change for this booking has been used; a fee would apply. Offer a human agent.',
        );
      }
      const from = booking.data.flight;
      return ok({
        summary: `Move booking ${ref} from flight ${from.flightNumber} to flight ${target.flightNumber ?? newFlightId}${target.departure ? ` departing ${target.departure}` : ''}, at no charge`,
        binding: {
          bookingRef: ref,
          newFlightId,
          currentFlightId: from.id,
          currentStatus: from.status,
          changesMade: booking.data.changesMade,
        },
      });
    },
  },

  async run({ bookingRef, newFlightId }, ctx) {
    const ref = normalizeRef(bookingRef);
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
      if (res.ok) return ok(summarizeBooking(res.data));
      if (res.error !== 'UNAVAILABLE') return res;
      // The write may have gone through even though we never saw the answer (timeout, dropped
      // connection). Look before reporting a failure, so the customer is neither told "failed" for a
      // change that happened nor encouraged to try again.
      const after = await fetchOwnedBooking(ref, ctx);
      if (after.ok && after.data.flight.id === newFlightId) {
        ctx.audit('mutation_reconciled', { bookingRef: ref, newFlightId });
        return ok(summarizeBooking(after.data));
      }
      return res;
    });
  },
  summarize: (d) => `Now on ${d.flightNumber}`,
  remember: (data) => ({ collected: { booking: data, rebooked: true }, step: 'act' }),
});
