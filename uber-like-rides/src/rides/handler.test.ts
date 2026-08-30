import { describe, expect, it } from 'vitest';
import { handleGetRide } from './handler';
import type { Ride } from './store';

const RIDE: Ride = {
  rideId: 'ride-1',
  riderId: 'rider-1',
  fareId: 'fare-1',
  status: 'MATCHING',
  attempt: 1,
  createdAt: 1000,
};

describe('GET /rides/{rideId} (task 5.2)', () => {
  it('returns the polling shape — driverId only once present', async () => {
    const res = await handleGetRide({ getRide: async () => RIDE }, 'ride-1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ rideId: 'ride-1', status: 'MATCHING', attempt: 1 });

    const offered = await handleGetRide(
      { getRide: async () => ({ ...RIDE, status: 'OFFERED' as const, driverId: 'driver-9' }) },
      'ride-1',
    );
    expect(JSON.parse(offered.body!).driverId).toBe('driver-9');
  });

  it('404 on unknown or missing ride id', async () => {
    const res = await handleGetRide({ getRide: async () => undefined }, 'ride-x');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!).error.code).toBe('NOT_FOUND');
    expect((await handleGetRide({ getRide: async () => RIDE }, undefined)).statusCode).toBe(404);
  });
});
