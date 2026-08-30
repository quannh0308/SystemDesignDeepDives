/**
 * Candidate finder (lld.md §5 GetCandidates state, hld.md §6.3): GEOSEARCH
 * radius ASC limit — then drop excluded drivers (already tried this ride) and
 * drivers with an active ride (rides `driverId-status` GSI via the lookup
 * seam). Order is preserved: nearest first. The Step Functions Lambda wrapper
 * arrives with task 4.
 */
import { requireEnv } from '../http/api';
import type { Point } from '../location/bbox';
import type { GeoCandidate, GeoClient } from '../location/geo-client';
import { RedisGeoClient } from '../location/redis-geo-client';
import { RideNotMatchableError, RideStore } from '../rides/store';
import { docClient } from '../rides/doc-client';

/** Implemented by RideStore.hasActiveRide; faked in unit tests. */
export interface ActiveRideLookup {
  hasActiveRide(driverId: string): Promise<boolean>;
}

export interface CandidateQuery {
  pickup: Point;
  excluded: readonly string[];
  radiusKm: number;
  limit: number;
}

export async function findCandidates(
  geo: GeoClient,
  rides: ActiveRideLookup,
  query: CandidateQuery,
): Promise<GeoCandidate[]> {
  const nearby = await geo.searchRadiusKm(query.pickup.lng, query.pickup.lat, query.radiusKm, query.limit);
  const excluded = new Set(query.excluded);
  const eligible = nearby.filter((c) => !excluded.has(c.driverId));
  const activeFlags = await Promise.all(eligible.map((c) => rides.hasActiveRide(c.driverId)));
  return eligible.filter((_, i) => !activeFlags[i]);
}

// ---------------------------------------------------------------------------
// Step Functions state wrapper
// ---------------------------------------------------------------------------

export interface CandidatesStepInput {
  rideId: string;
  pickup: Point;
  excluded: string[];
  /** Match budget as an absolute deadline (lld.md §5): past it, report no candidates → MarkFailed. */
  deadlineMs: number;
}

export interface CandidatesStepDeps {
  geo: GeoClient;
  rides: ActiveRideLookup & Pick<RideStore, 'markMatching'>;
  radiusKm: number;
  limit: number;
  now(): number;
}

/**
 * GetCandidates state: enforce the match budget, keep the ride in MATCHING
 * (idempotent guard — re-entry after a released offer is a no-op; a cancelled
 * ride refuses and we report no candidates, where the guarded MarkFailed
 * preserves the terminal state), then search.
 */
export async function handleGetCandidates(
  deps: CandidatesStepDeps,
  input: CandidatesStepInput,
): Promise<{ candidates: GeoCandidate[] }> {
  if (deps.now() > input.deadlineMs) return { candidates: [] };
  try {
    await deps.rides.markMatching(input.rideId);
  } catch (error) {
    if (error instanceof RideNotMatchableError) return { candidates: [] };
    throw error;
  }
  const candidates = await findCandidates(deps.geo, deps.rides, {
    pickup: input.pickup,
    excluded: input.excluded,
    radiusKm: deps.radiusKm,
    limit: deps.limit,
  });
  return { candidates };
}

let deps: CandidatesStepDeps | undefined;

function liveDeps(): CandidatesStepDeps {
  return (deps ??= {
    geo: RedisGeoClient.fromEndpoint(requireEnv('REDIS_ENDPOINT')),
    rides: new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: '' }),
    radiusKm: Number(requireEnv('SEARCH_RADIUS_KM')),
    limit: Number(requireEnv('CANDIDATE_LIMIT')),
    now: () => Date.now(),
  });
}

export async function handler(input: CandidatesStepInput): Promise<{ candidates: GeoCandidate[] }> {
  return handleGetCandidates(liveDeps(), input);
}
