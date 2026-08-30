import { describe, expect, it } from 'vitest';
import { parseBbox } from '../location/bbox';
import type { Fare } from '../rides/store';
import { handleCreateFare, type FareDeps } from './handler';
import { CityRouting } from './routing';

const NOW_MS = 1_700_000_000_123;

function deps(): FareDeps & { saved: Fare[] } {
  const saved: Fare[] = [];
  return {
    saved,
    store: { createFare: async (fare) => void saved.push(fare) },
    routing: new CityRouting(),
    bbox: parseBbox('52.35,13.20,52.60,13.55'),
    fareTtlS: 300,
    now: () => NOW_MS,
    newId: () => 'fare-fixed-id',
  };
}

const RIDER = { role: 'rider', id: 'rider-7' } as const;
const BODY = {
  pickup: { lat: 52.5163, lng: 13.3777 },
  destination: { lat: 52.5219, lng: 13.4132 },
};

describe('POST /fares (task 5.2)', () => {
  it('prices a valid request and returns the §2.2 contract shape', async () => {
    const d = deps();
    const res = await handleCreateFare(d, RIDER, BODY);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({
      fareId: 'fare-fixed-id',
      priceCents: expect.any(Number),
      currency: 'EUR',
      etaSeconds: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    expect(body.priceCents).toBeGreaterThan(300); // base + distance + time
  });

  it('fare expiry boundary: expiresAt = floor(now/1000) + FARE_TTL_S, in epoch seconds (TTL unit)', async () => {
    const d = deps();
    await handleCreateFare(d, RIDER, BODY);
    const fare = d.saved[0]!;
    expect(fare.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 300);
    expect(fare.createdAt).toBe(NOW_MS); // ms — the units split is deliberate
    expect(fare.riderId).toBe('rider-7'); // identity from token, not body
  });

  it('rejects coordinates outside the city bbox with 400 BAD_COORDS', async () => {
    const d = deps();
    const res = await handleCreateFare(d, RIDER, {
      pickup: { lat: 48.13, lng: 11.58 }, // Munich
      destination: BODY.destination,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.code).toBe('BAD_COORDS');
    expect(d.saved).toHaveLength(0);
  });

  it('rejects missing/malformed coordinate objects', async () => {
    const res = await handleCreateFare(deps(), RIDER, { pickup: { lat: 52.5 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects drivers — fare quotes are rider-only', async () => {
    const res = await handleCreateFare(deps(), { role: 'driver', id: 'driver-1' }, BODY);
    expect(res.statusCode).toBe(403);
  });
});
