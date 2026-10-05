import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createMockApp, defaultOptions } from '../../mock-services/src/app';
import {
  buildIdempotencyKey,
  createMemoryIdempotencyStore,
  withIdempotency,
} from '@backend/tools/security';
import { ok } from '@adk/shared';

let app: ReturnType<typeof createMockApp>;
let auth: string;

async function token() {
  const res = await request(app).post('/airline/oauth/token').send({
    grant_type: 'client_credentials',
    client_id: 'adk-backend',
    client_secret: 'test-client-secret',
  });
  return `Bearer ${res.body.access_token as string}`;
}

beforeEach(async () => {
  app = createMockApp(defaultOptions());
  auth = await token();
});

async function altFlightFor(ref: string) {
  const booking = await request(app).get(`/airline/bookings/${ref}`).set('authorization', auth);
  const f = booking.body.data.flight;
  const alts = await request(app)
    .get('/airline/flights/alternatives')
    .query({ origin: f.origin, destination: f.destination, after: f.departure })
    .set('authorization', auth);
  return alts.body.data[0] as { id: string; seatsLeft: number };
}

describe('mock airline API idempotency', () => {
  it('same Idempotency-Key twice results in exactly one change', async () => {
    const alt = await altFlightFor('SK1001');
    const send = () =>
      request(app)
        .post('/airline/bookings/SK1001/change')
        .set('authorization', auth)
        .set('idempotency-key', 'abc')
        .send({ newFlightId: alt.id });

    const first = await send();
    const second = await send();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);

    const booking = await request(app).get('/airline/bookings/SK1001').set('authorization', auth);
    expect(booking.body.data.changesMade).toBe(1); // not 2
    expect(booking.body.data.flight.seatsLeft).toBe(alt.seatsLeft - 1); // one seat taken, not two
  });

  it('requires an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/airline/bookings/SK1001/change')
      .set('authorization', auth)
      .send({ newFlightId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects reuse of a key for a different request', async () => {
    const alt = await altFlightFor('SK1001');
    await request(app)
      .post('/airline/bookings/SK1001/change')
      .set('authorization', auth)
      .set('idempotency-key', 'k')
      .send({ newFlightId: alt.id });
    const res = await request(app)
      .post('/airline/bookings/SK1002/change')
      .set('authorization', auth)
      .set('idempotency-key', 'k')
      .send({ newFlightId: alt.id });
    expect(res.status).toBe(422);
  });

  it('rejects calls without a token', async () => {
    const res = await request(app).get('/airline/bookings/SK1001');
    expect(res.status).toBe(401);
  });

  it('forces a 503 when the simulator header is set', async () => {
    const res = await request(app)
      .get('/airline/bookings/SK1001')
      .set('authorization', auth)
      .set('x-sim-fail', '1');
    expect(res.status).toBe(503);
  });
});

describe('backend idempotency helper', () => {
  it('builds stable keys from the same inputs', () => {
    expect(buildIdempotencyKey('c1', 'SK1001', 'F1')).toBe(
      buildIdempotencyKey('c1', 'SK1001', 'F1'),
    );
    expect(buildIdempotencyKey('c1', 'SK1001', 'F1')).not.toBe(
      buildIdempotencyKey('c1', 'SK1001', 'F2'),
    );
  });

  it('runs a write once per key and replays the cached success', async () => {
    const store = createMemoryIdempotencyStore();
    let runs = 0;
    const run = async () => ok({ runs: ++runs });
    const a = await withIdempotency(store, 'k', run);
    const b = await withIdempotency(store, 'k', run);
    expect(runs).toBe(1);
    expect(b).toEqual(a);
  });

  it('does not cache failures', async () => {
    const store = createMemoryIdempotencyStore();
    let runs = 0;
    const run = async () =>
      ++runs === 1 ? ({ ok: false, error: 'UNAVAILABLE', message: 'x' } as const) : ok({ runs });
    await withIdempotency(store, 'k', run);
    const second = await withIdempotency(store, 'k', run);
    expect(second.ok).toBe(true);
    expect(runs).toBe(2);
  });
});
