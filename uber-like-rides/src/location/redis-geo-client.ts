/**
 * ioredis adapter for the GeoClient seam (lld.md §4): 2 s command timeout,
 * fail toward liveness — correctness stays guarded by the conditional writes.
 * Unit tests never touch this class; it is exercised against real ElastiCache
 * from task 7 (smoke) onward.
 */
import { Redis } from 'ioredis';
import { GEO_KEY, TS_KEY, type GeoCandidate, type GeoClient } from './geo-client';

export class RedisGeoClient implements GeoClient {
  constructor(private readonly redis: Redis) {}

  static fromEndpoint(endpoint: string): RedisGeoClient {
    const [host, port] = endpoint.split(':');
    return new RedisGeoClient(
      new Redis({
        host,
        port: Number(port ?? 6379),
        commandTimeout: 2000,
        lazyConnect: true,
      }),
    );
  }

  async recordPing(driverId: string, lng: number, lat: number, atMs: number): Promise<void> {
    await this.redis.multi().geoadd(GEO_KEY, lng, lat, driverId).zadd(TS_KEY, atMs, driverId).exec();
  }

  async membersStalerThan(cutoffMs: number): Promise<string[]> {
    return this.redis.zrangebyscore(TS_KEY, '-inf', `(${cutoffMs}`);
  }

  async evict(driverIds: string[]): Promise<void> {
    if (driverIds.length === 0) return;
    await this.redis.multi().zrem(GEO_KEY, ...driverIds).zrem(TS_KEY, ...driverIds).exec();
  }

  async searchRadiusKm(lng: number, lat: number, radiusKm: number, limit: number): Promise<GeoCandidate[]> {
    const raw = (await this.redis.call(
      'GEOSEARCH',
      GEO_KEY,
      'FROMLONLAT',
      String(lng),
      String(lat),
      'BYRADIUS',
      String(radiusKm),
      'km',
      'ASC',
      'COUNT',
      String(limit),
      'WITHDIST',
    )) as Array<[string, string]>;
    return raw.map(([driverId, dist]) => ({ driverId, distanceKm: Number(dist) }));
  }
}
