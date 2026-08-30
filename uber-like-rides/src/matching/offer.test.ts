import { describe, expect, it } from 'vitest';
import { LostMatchRaceError, StaleReleaseError } from '../rides/store';
import { InMemoryLockClient } from './driver-lock.fake';
import { handleOffer, LockBusyError, type OfferDeps, type OfferStepInput } from './offer';
import { handleRelease, type ReleaseDeps } from './release';
import type { DriverOffer } from './offer-store';

const NOW = 1_700_000_000_000;

function input(overrides: Partial<OfferStepInput> = {}): OfferStepInput {
  return {
    rideId: 'ride-1',
    driverId: 'driver-9',
    pickup: { lat: 52.52, lng: 13.4 },
    priceCents: 1234,
    excluded: [],
    taskToken: 'token-abc',
    ...overrides,
  };
}

function offerDeps(overrides: Partial<OfferDeps> = {}) {
  const put: DriverOffer[] = [];
  const marked: Array<{ rideId: string; driverId: string; attempt: number }> = [];
  const locks = new InMemoryLockClient(() => NOW);
  const deps: OfferDeps = {
    rides: {
      markOffered: async (rideId, driverId, attempt) => void marked.push({ rideId, driverId, attempt }),
    },
    offers: { put: async (offer) => void put.push(offer) },
    locks,
    lockTtlMs: 10_000,
    now: () => NOW,
    ...overrides,
  };
  return { deps, put, marked, locks };
}

describe('offer step (tasks 4.4/4.5)', () => {
  it('happy path: lock → markOffered(attempt = excluded+1) → offer row with token and TTL', async () => {
    const { deps, put, marked, locks } = offerDeps();
    await handleOffer(deps, input({ excluded: ['driver-1', 'driver-2'] }));
    expect(marked).toEqual([{ rideId: 'ride-1', driverId: 'driver-9', attempt: 3 }]);
    expect(locks.holder('driver-9')).toBe('ride-1');
    expect(put[0]).toMatchObject({
      driverId: 'driver-9',
      rideId: 'ride-1',
      taskToken: 'token-abc',
      offeredAt: NOW,
      expiresAt: Math.floor((NOW + 10_000) / 1000),
    });
    expect(put[0]!.taskToken).toBeDefined();
  });

  it('driver locked by another ride → LOCK_BUSY, nothing written', async () => {
    const { deps, put, marked, locks } = offerDeps();
    await locks.acquire('driver-9', 'ride-OTHER', 10_000);
    await expect(handleOffer(deps, input())).rejects.toBeInstanceOf(LockBusyError);
    expect(marked).toHaveLength(0);
    expect(put).toHaveLength(0);
  });

  it('markOffered lost the race → lock released immediately, error propagates to the release path', async () => {
    const { deps, put, locks } = offerDeps({
      rides: {
        markOffered: async () => {
          throw new LostMatchRaceError('ride-1');
        },
      },
    });
    await expect(handleOffer(deps, input())).rejects.toBeInstanceOf(LostMatchRaceError);
    expect(locks.holder('driver-9')).toBeUndefined();
    expect(put).toHaveLength(0);
  });

  it('idempotent re-offer: same driver again after a release — attempt advances, lock re-acquired', async () => {
    const { deps, marked, locks } = offerDeps();
    await handleOffer(deps, input({ excluded: [] }));
    await locks.release('driver-9', 'ride-1'); // release path freed the driver
    await handleOffer(deps, input({ excluded: ['driver-4'] }));
    expect(marked.map((m) => m.attempt)).toEqual([1, 2]);
    expect(locks.holder('driver-9')).toBe('ride-1');
  });
});

describe('release step', () => {
  function releaseDeps(overrides: Partial<ReleaseDeps> = {}) {
    const released: number[] = [];
    const deleted: string[] = [];
    const locks = new InMemoryLockClient(() => NOW);
    const deps: ReleaseDeps = {
      rides: { releaseOffer: async (_r, _d, attempt) => void released.push(attempt) },
      offers: { delete: async (_d, rideId) => (deleted.push(rideId), true) },
      locks,
      ...overrides,
    };
    return { deps, released, deleted, locks };
  }

  const releaseInput = {
    rideId: 'ride-1',
    driverId: 'driver-9',
    pickup: { lat: 52.52, lng: 13.4 },
    priceCents: 1234,
    excluded: ['driver-4'],
    deadlineMs: NOW + 60_000,
  };

  it('releases with the same attempt derivation the offer used, cleans up, excludes the driver', async () => {
    const { deps, released, deleted, locks } = releaseDeps();
    await locks.acquire('driver-9', 'ride-1', 10_000);
    const out = await handleRelease(deps, releaseInput);
    expect(released).toEqual([2]); // excluded.length + 1
    expect(deleted).toEqual(['ride-1']);
    expect(locks.holder('driver-9')).toBeUndefined();
    expect(out.excluded).toEqual(['driver-4', 'driver-9']);
    expect(out.deadlineMs).toBe(releaseInput.deadlineMs); // budget flows through
  });

  it('accept won the race → StaleReleaseError swallowed, cleanup still runs', async () => {
    const { deps, deleted } = releaseDeps({
      rides: {
        releaseOffer: async () => {
          throw new StaleReleaseError('ride-1');
        },
      },
    });
    const out = await handleRelease(deps, releaseInput);
    expect(deleted).toEqual(['ride-1']);
    expect(out.excluded).toContain('driver-9');
  });
});
