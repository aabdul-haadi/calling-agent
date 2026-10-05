import { z } from 'zod';
import { ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { fetchOwnedBooking, normalizeRef, refSchema } from './api';

/** Small, flat view of a booking: this is all the model (and conversation state) ever sees. */
export function summarizeBooking(b: {
  ref: string;
  fareClass: string;
  changesMade: number;
  flight: {
    flightNumber: string;
    origin: string;
    destination: string;
    departure: string;
    arrival: string;
    status: string;
  };
}) {
  return {
    ref: b.ref,
    status: b.flight.status === 'CANCELLED' ? 'FLIGHT_CANCELLED_BY_AIRLINE' : 'ON_SCHEDULE',
    flightNumber: b.flight.flightNumber,
    origin: b.flight.origin,
    destination: b.flight.destination,
    departure: b.flight.departure,
    arrival: b.flight.arrival,
    fareClass: b.fareClass,
    changesMade: b.changesMade,
  };
}

export const getBooking = defineTool({
  name: 'get_booking',
  description:
    "Look up a verified passenger's booking by reference. Shows the flight and whether it was cancelled.",
  input: z.object({ bookingRef: refSchema }),
  label: 'Checked the booking system',
  async run({ bookingRef }, ctx) {
    const res = await fetchOwnedBooking(bookingRef, ctx);
    return res.ok ? ok(summarizeBooking(res.data)) : res;
  },
  summarize: (d) =>
    d.status === 'FLIGHT_CANCELLED_BY_AIRLINE' ? 'Flight was cancelled' : 'Flight is on schedule',
  remember: (data, input) => ({
    collected: { booking: data, bookingRef: normalizeRef(input.bookingRef) },
    step: 'look_up',
  }),
});
