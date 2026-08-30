/**
 * ReleaseOffer step (lld.md §5.6): runs after timeout, decline, or LOCK_BUSY.
 * Every rung is idempotent, so one path serves all three:
 * - guarded `releaseOffer` (OFFERED→MATCHING, pinned to driver AND attempt) —
 *   StaleReleaseError means an accept won the race or nothing was written;
 * - conditional offer-row delete (pinned to rideId);
 * - owner-checked lock release.
 * Returns the next workflow context with the driver excluded.
 */
import { requireEnv } from '../http/api';
import { RideStore, StaleReleaseError } from '../rides/store';
import { docClient } from '../rides/doc-client';
import { RedisLockClient, type LockClient } from './driver-lock';
import { OfferStore } from './offer-store';

export interface ReleaseInput {
  rideId: string;
  driverId: string;
  pickup: { lat: number; lng: number };
  priceCents: number;
  excluded: string[];
  deadlineMs: number;
}

export interface ReleaseOutput {
  rideId: string;
  pickup: { lat: number; lng: number };
  priceCents: number;
  excluded: string[];
  deadlineMs: number;
}

export interface ReleaseDeps {
  rides: Pick<RideStore, 'releaseOffer'>;
  offers: Pick<OfferStore, 'delete'>;
  locks: LockClient;
}

export async function handleRelease(deps: ReleaseDeps, input: ReleaseInput): Promise<ReleaseOutput> {
  const attempt = input.excluded.length + 1; // same derivation the offer step used

  try {
    await deps.rides.releaseOffer(input.rideId, input.driverId, attempt);
  } catch (error) {
    if (!(error instanceof StaleReleaseError)) throw error;
    // Accept won the race, or the offer step never got past the lock — either
    // way the ride record is already right.
  }
  await deps.offers.delete(input.driverId, input.rideId);
  await deps.locks.release(input.driverId, input.rideId);

  return {
    rideId: input.rideId,
    pickup: input.pickup,
    priceCents: input.priceCents,
    excluded: [...input.excluded, input.driverId],
    deadlineMs: input.deadlineMs,
  };
}

let deps: ReleaseDeps | undefined;

function liveDeps(): ReleaseDeps {
  return (deps ??= {
    rides: new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: '' }),
    offers: new OfferStore(docClient(), requireEnv('OFFERS_TABLE')),
    locks: RedisLockClient.fromEndpoint(requireEnv('REDIS_ENDPOINT')),
  });
}

export async function handler(input: ReleaseInput): Promise<ReleaseOutput> {
  return handleRelease(liveDeps(), input);
}
