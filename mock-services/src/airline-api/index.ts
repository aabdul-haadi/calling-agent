import { Router } from 'express';
import { buildAirlineSeed, type Booking, type Flight } from '../seed-data/airline';
import { createAuth, sendError, simulate, type MockOptions } from '../common';

interface StoredResponse {
  fingerprint: string;
  status: number;
  body: unknown;
}

const withFlight = (booking: Booking, flights: Map<string, Flight>) => ({
  ref: booking.ref,
  passengerId: booking.passengerId,
  firstName: booking.firstName,
  lastName: booking.lastName,
  fareClass: booking.fareClass,
  changesMade: booking.changesMade,
  flight: flights.get(booking.flightId),
});

export function createAirlineApi(opts: MockOptions): Router {
  const seed = buildAirlineSeed();
  const flights = new Map(seed.flights.map((f) => [f.id, f]));
  const bookings = new Map(seed.bookings.map((b) => [b.ref, b]));
  // Server-side idempotency: the same key replays the first answer instead of changing again.
  const idempotency = new Map<string, StoredResponse>();

  const { tokenRouter, requireToken } = createAuth(opts);
  const router = Router();
  router.use(tokenRouter);
  router.use(requireToken, simulate(opts));

  router.get('/bookings/:ref', (req, res) => {
    const booking = bookings.get(req.params.ref ?? '');
    if (!booking) return sendError(res, 404, 'BOOKING_NOT_FOUND', 'No such booking');
    res.json({ data: withFlight(booking, flights) });
  });

  router.get('/flights/alternatives', (req, res) => {
    const { origin, destination, after } = req.query as Record<string, string | undefined>;
    if (!origin || !destination) {
      return sendError(res, 400, 'MISSING_PARAMS', 'origin and destination are required');
    }
    const afterMs = after ? Date.parse(after) : Date.now();
    const found = [...flights.values()]
      .filter(
        (f) =>
          f.origin === origin &&
          f.destination === destination &&
          f.status === 'SCHEDULED' &&
          f.seatsLeft > 0 &&
          Date.parse(f.departure) >= (Number.isNaN(afterMs) ? 0 : afterMs),
      )
      .sort((a, b) => a.departure.localeCompare(b.departure))
      .slice(0, 5);
    res.json({ data: found });
  });

  router.post('/bookings/:ref/change', (req, res) => {
    const key = req.header('idempotency-key');
    if (!key)
      return sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const ref = req.params.ref ?? '';
    const { newFlightId } = (req.body ?? {}) as { newFlightId?: string };
    const fingerprint = `${ref}:${newFlightId}`;

    const previous = idempotency.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return sendError(
          res,
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Key was used for a different request',
        );
      }
      res.setHeader('idempotent-replay', 'true');
      return res.status(previous.status).json(previous.body);
    }

    const respond = (status: number, body: unknown) => {
      idempotency.set(key, { fingerprint, status, body });
      res.status(status).json(body);
    };
    const err = (status: number, code: string, message: string) =>
      respond(status, { error: { code, message } });

    const booking = bookings.get(ref);
    if (!booking) return err(404, 'BOOKING_NOT_FOUND', 'No such booking');
    const target = newFlightId ? flights.get(newFlightId) : undefined;
    if (!target) return err(404, 'FLIGHT_NOT_FOUND', 'No such flight');
    const current = flights.get(booking.flightId)!;
    if (target.id === current.id)
      return err(409, 'ALREADY_ON_FLIGHT', 'Booking is already on that flight');
    if (target.status !== 'SCHEDULED' || target.seatsLeft < 1) {
      return err(409, 'FLIGHT_UNAVAILABLE', 'Flight is cancelled or full');
    }
    if (target.origin !== current.origin || target.destination !== current.destination) {
      return err(422, 'ROUTE_MISMATCH', 'New flight must serve the same route');
    }
    target.seatsLeft -= 1;
    booking.flightId = target.id;
    booking.changesMade += 1;
    respond(200, { data: withFlight(booking, flights) });
  });

  return router;
}
