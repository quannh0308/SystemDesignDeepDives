/**
 * Geo client seam (lld.md §4): the exact Redis operations the system uses,
 * as an interface. CORE logic unit-tests against `InMemoryGeoClient`
 * (geo-client.fake.ts); the real ioredis adapter (redis-geo-client.ts) is
 * exercised from task 7 onward.
 */

/** Redis GEO set: driver positions, one member per driver, overwritten per ping. */
export const GEO_KEY = 'geo:drivers';
/** Redis ZSET: last-ping timestamp (ms) per driver — the sweeper's source of truth. */
export const TS_KEY = 'geo:drivers:ts';

export interface GeoCandidate {
  driverId: string;
  distanceKm: number;
}

export interface GeoClient {
  /** GEOADD geo:drivers + ZADD geo:drivers:ts — one ping updates both keys. */
  recordPing(driverId: string, lng: number, lat: number, atMs: number): Promise<void>;

  /** ZRANGEBYSCORE geo:drivers:ts -inf (cutoffMs — members whose last ping is STRICTLY older. */
  membersStalerThan(cutoffMs: number): Promise<string[]>;

  /** ZREM from both keys. */
  evict(driverIds: string[]): Promise<void>;

  /** GEOSEARCH FROMLONLAT … BYRADIUS km ASC COUNT limit — nearest first, with distances. */
  searchRadiusKm(lng: number, lat: number, radiusKm: number, limit: number): Promise<GeoCandidate[]>;
}
