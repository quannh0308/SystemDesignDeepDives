/**
 * OfferToDriver step (lld.md §5.4, hld.md Deep Dives 9.2/9.4). Order matters:
 * 1. lock (`SET NX PX`) — busy means another ride holds this driver, throw
 *    LOCK_BUSY and let the workflow exclude + move on;
 * 2. `markOffered` conditional write — the final arbiter;
 * 3. offer row with the task token — the driver's poll surface.
 * The Lambda returns without resolving anything: the state waits for the task
 * token (accept resolves it, decline fails it, 10 s timeout fires otherwise).
 * A crash after any rung self-heals: the release path's guards make partial
 * work harmless, and the lock TTL frees the driver.
 */
import { requireEnv } from '../http/api';
import { RideStore } from '../rides/store';
import { docClient } from '../rides/doc-client';
import { RedisLockClient, type LockClient } from './driver-lock';
import { OfferStore } from './offer-store';

export class LockBusyError extends Error {
  readonly code = 'LOCK_BUSY';
  constructor(driverId: string) {
    super(`Driver ${driverId} is locked by another ride`);
    this.name = 'LockBusyError';
  }
}

export interface OfferStepInput {
  rideId: string;
  driverId: string;
  pickup: { lat: number; lng: number };
  priceCents: number;
  excluded: string[];
  taskToken: string;
}

export interface OfferDeps {
  rides: Pick<RideStore, 'markOffered'>;
  offers: Pick<OfferStore, 'put'>;
  locks: LockClient;
  lockTtlMs: number;
  now(): number;
}

export async function handleOffer(deps: OfferDeps, input: OfferStepInput): Promise<void> {
  const attempt = input.excluded.length + 1;

  const acquired = await deps.locks.acquire(input.driverId, input.rideId, deps.lockTtlMs);
  if (!acquired) throw new LockBusyError(input.driverId);

  const now = deps.now();
  try {
    await deps.rides.markOffered(input.rideId, input.driverId, attempt, now);
  } catch (error) {
    await deps.locks.release(input.driverId, input.rideId); // nothing written — free the driver now
    throw error;
  }

  // If this put fails, the ride is left OFFERED — the workflow's catch runs
  // the release path, whose guarded write flips it back to MATCHING.
  await deps.offers.put({
    driverId: input.driverId,
    rideId: input.rideId,
    taskToken: input.taskToken,
    priceCents: input.priceCents,
    pickupLat: input.pickup.lat,
    pickupLng: input.pickup.lng,
    offeredAt: now,
    expiresAt: Math.floor((now + deps.lockTtlMs) / 1000),
  });
}

let deps: OfferDeps | undefined;

function liveDeps(): OfferDeps {
  return (deps ??= {
    rides: new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: '' }),
    offers: new OfferStore(docClient(), requireEnv('OFFERS_TABLE')),
    locks: RedisLockClient.fromEndpoint(requireEnv('REDIS_ENDPOINT')),
    lockTtlMs: Number(requireEnv('LOCK_TTL_MS')),
    now: () => Date.now(),
  });
}

export async function handler(input: OfferStepInput): Promise<void> {
  return handleOffer(liveDeps(), input);
}
