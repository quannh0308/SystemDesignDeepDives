/**
 * Candidate finder (lld.md §5 GetCandidates state, hld.md §6.3): GEOSEARCH
 * radius ASC limit — then drop excluded drivers (already tried this ride) and
 * drivers with an active ride (rides `driverId-status` GSI via the lookup
 * seam). Order is preserved: nearest first. The Step Functions Lambda wrapper
 * arrives with task 4.
 */
import type { Point } from '../location/bbox';
import type { GeoCandidate, GeoClient } from '../location/geo-client';

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
