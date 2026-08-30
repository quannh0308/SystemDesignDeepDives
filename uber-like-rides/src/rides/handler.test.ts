import { describe, expect, it } from 'vitest';
import type { DriverOffer } from '../matching/offer-store';
import {
  handleCreateRide,
  handleDriverAction,
  handleGetRide,
  type RideDeps,
} from './handler';
import { FareUnavailableError, StaleOfferError, type Fare, type Ride } from './store';

const NOW = 1_700_000_000_000;
const RIDER = { role: 'rider', id: 'rider-1' } as const;
const DRIVER = { role: 'driver', id: 'driver-9' } as const;

const FARE: Fare = {
  fareId: 'fare-1',
  riderId: 'rider-1',
  pickupLat: 52.52,
  pickupLng: 13.4,
  destLat: 52.53,
  destLng: 13.41,
  priceCents: 900,
  etaSeconds: 300,
  createdAt: NOW - 1000,
  expiresAt: Math.floor(NOW / 1000) + 200,
};

const OFFER: DriverOffer = {
  driverId: 'driver-9',
  rideId: 'ride-1',
  taskToken: 'token-abc',
  priceCents: 900,
  pickupLat: 52.52,
  pickupLng: 13.4,
  offeredAt: NOW,
  expiresAt: Math.floor(NOW / 1000) + 10,
};

interface Fakes {
  calls: string[];
  deps: RideDeps;
}

function fakes(overrides: Partial<RideDeps['store']> = {}, offer: DriverOffer | undefined = OFFER): Fakes {
  const calls: string[] = [];
  const deps: RideDeps = {
    store: {
      getRide: async () => undefined,
      getFare: async () => FARE,
      useFare: async () => void calls.push('useFare'),
      createRide: async (ride: Ride) => void calls.push(`createRide:${ride.status}`),
      acceptRide: async () => (calls.push('acceptRide'), { rideId: 'ride-1' } as Ride),
      ...overrides,
    },
    offers: {
      get: async () => offer,
      delete: async () => (calls.push('deleteOffer'), true),
    },
    queue: { enqueue: async (m) => void calls.push(`enqueue:${m.rideId}`) },
    workflow: {
      taskSuccess: async () => void calls.push('taskSuccess'),
      taskFailure: async (_t, error) => void calls.push(`taskFailure:${error}`),
    },
    now: () => NOW,
    newId: () => 'ride-1',
  };
  return { calls, deps };
}

describe('POST /rides (task 4.1)', () => {
  it('202: useFare arbitrates, ride persists, THEN the match request enqueues', async () => {
    const { calls, deps } = fakes();
    const res = await handleCreateRide(deps, RIDER, { fareId: 'fare-1' });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body!)).toEqual({ rideId: 'ride-1', status: 'REQUESTED' });
    expect(calls).toEqual(['useFare', 'createRide:REQUESTED', 'enqueue:ride-1']); // order pinned
  });

  it("another rider's fare → 404, fare never consumed", async () => {
    const { calls, deps } = fakes();
    const res = await handleCreateRide(deps, { role: 'rider', id: 'rider-OTHER' }, { fareId: 'fare-1' });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('fare already used / expired → 409 with the specific code, nothing persisted', async () => {
    const { calls, deps } = fakes({
      useFare: async () => {
        throw new FareUnavailableError('FARE_ALREADY_USED', 'fare-1');
      },
    });
    const res = await handleCreateRide(deps, RIDER, { fareId: 'fare-1' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body!).error.code).toBe('FARE_ALREADY_USED');
    expect(calls).toEqual([]);
  });
});

describe('PATCH /rides/{rideId} (tasks 4.4/4.5)', () => {
  it('accept: guard first, task token resolved only AFTER acceptRide succeeds', async () => {
    const { calls, deps } = fakes();
    const res = await handleDriverAction(deps, DRIVER, 'ride-1', { action: 'accept' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ status: 'ACCEPTED' });
    expect(calls).toEqual(['acceptRide', 'taskSuccess', 'deleteOffer']); // token strictly after guard
  });

  it('stale accept → 409 STALE_OFFER and the token is NEVER resolved', async () => {
    const { calls, deps } = fakes({
      acceptRide: async () => {
        throw new StaleOfferError('ride-1'); // only the guard produces this — the 409 proves it ran
      },
    });
    const res = await handleDriverAction(deps, DRIVER, 'ride-1', { action: 'accept' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body!).error.code).toBe('STALE_OFFER');
    expect(calls).toEqual([]); // no taskSuccess, no deleteOffer — token untouched after a failed guard
  });

  it('offer reassigned (row now carries a different ride) → 409 STALE_OFFER before any guard', async () => {
    const { calls, deps } = fakes({}, { ...OFFER, rideId: 'ride-NEWER' });
    const res = await handleDriverAction(deps, DRIVER, 'ride-1', { action: 'accept' });
    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  it('decline: fails the task token so the workflow releases and moves on', async () => {
    const { calls, deps } = fakes();
    const res = await handleDriverAction(deps, DRIVER, 'ride-1', { action: 'decline' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['taskFailure:DriverDeclined', 'deleteOffer']);
  });

  it('riders cannot act on offers; unknown action rejected', async () => {
    const { deps } = fakes();
    expect((await handleDriverAction(deps, RIDER, 'ride-1', { action: 'accept' })).statusCode).toBe(403);
    expect((await handleDriverAction(deps, DRIVER, 'ride-1', { action: 'maybe' })).statusCode).toBe(400);
  });
});

describe('GET /rides/{rideId} (task 5.2)', () => {
  const ride: Ride = {
    rideId: 'ride-1',
    riderId: 'rider-1',
    fareId: 'fare-1',
    status: 'MATCHING',
    attempt: 1,
    createdAt: 1000,
  };

  it('returns the polling shape — driverId only once present', async () => {
    const { deps } = fakes({ getRide: async () => ride });
    const res = await handleGetRide(deps, 'ride-1');
    expect(JSON.parse(res.body!)).toEqual({ rideId: 'ride-1', status: 'MATCHING', attempt: 1 });

    const { deps: offered } = fakes({
      getRide: async () => ({ ...ride, status: 'OFFERED' as const, driverId: 'driver-9' }),
    });
    expect(JSON.parse((await handleGetRide(offered, 'ride-1')).body!).driverId).toBe('driver-9');
  });

  it('404 on unknown or missing ride id', async () => {
    const { deps } = fakes();
    expect((await handleGetRide(deps, 'ride-x')).statusCode).toBe(404);
    expect((await handleGetRide(deps, undefined)).statusCode).toBe(404);
  });
});
