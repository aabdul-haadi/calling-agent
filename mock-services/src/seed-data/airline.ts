import { FIRST_NAMES, LAST_NAMES, createRng } from './rng';

// All data here is fictional. "SkyLink Air" is not a real airline.
export interface Flight {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  seatsLeft: number;
  status: 'SCHEDULED' | 'CANCELLED';
}

export interface Booking {
  ref: string;
  passengerId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  flightId: string;
  fareClass: 'ECONOMY' | 'FLEX' | 'BUSINESS';
  changesMade: number;
}

export interface AirlineSeed {
  flights: Flight[];
  bookings: Booking[];
}

const ROUTES: [string, string, string, number][] = [
  ['JFK', 'LHR', 'SK100', 7], ['LHR', 'JFK', 'SK101', 8], ['JFK', 'CDG', 'SK200', 7],
  ['CDG', 'JFK', 'SK201', 8], ['SFO', 'SIN', 'SK300', 16], ['SIN', 'SFO', 'SK301', 16],
];
const DEPARTURE_HOURS = [7, 11, 15, 19];
const BASE_DATE = Date.UTC(2026, 10, 10); // 10 Nov 2026

export function buildAirlineSeed(): AirlineSeed {
  const rng = createRng(1001);
  const flights: Flight[] = [];
  ROUTES.forEach(([origin, destination, prefix, hours], routeIdx) => {
    for (let day = 0; day < 6; day++) {
      DEPARTURE_HOURS.forEach((hour, slot) => {
        const dep = BASE_DATE + day * 86_400_000 + hour * 3_600_000;
        const flightNumber = `${prefix.slice(0, 2)}${Number(prefix.slice(2)) + slot * 10 + routeIdx % 2}`;
        flights.push({
          id: `${flightNumber}-${new Date(dep).toISOString().slice(0, 10)}`,
          flightNumber,
          origin,
          destination,
          departure: new Date(dep).toISOString(),
          arrival: new Date(dep + hours * 3_600_000).toISOString(),
          seatsLeft: rng.int(0, 12),
          status: 'SCHEDULED',
        });
      });
    }
  });

  // Cancelled flights that drive the demo story ("my flight was cancelled").
  const cancelledIds = [0, 24, 48, 72, 96, 120].map((i) => flights[i]!.id);
  for (const f of flights) {
    if (cancelledIds.includes(f.id)) {
      f.status = 'CANCELLED';
      f.seatsLeft = 0;
    }
  }
  // Guarantee alternatives exist for the first demo route.
  for (const f of flights) if (f.origin === 'JFK' && f.destination === 'LHR' && f.status === 'SCHEDULED') f.seatsLeft = Math.max(f.seatsLeft, 3);

  const bookings: Booking[] = [];
  for (let i = 0; i < 20; i++) {
    const first = FIRST_NAMES[i]!;
    const last = LAST_NAMES[i]!;
    // First 6 bookings sit on cancelled flights; the rest are on healthy flights.
    const flight = i < 6 ? flights.find((f) => f.id === cancelledIds[i])! : flights.filter((f) => f.status === 'SCHEDULED')[i * 3]!;
    bookings.push({
      ref: `SK${1001 + i}`,
      passengerId: `P${String(i + 1).padStart(3, '0')}`,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.test`,
      phone: `+1555010${String(i).padStart(4, '0')}`,
      flightId: flight.id,
      fareClass: (['ECONOMY', 'FLEX', 'BUSINESS'] as const)[i % 3]!,
      changesMade: i === 5 ? 1 : 0, // booking SK1006 already used its free change
    });
  }
  return { flights, bookings };
}
