/**
 * Stale-driver sweeper (lld.md §4, hld.md Deep Dive 9.1): every minute, evict
 * drivers whose last ping is STRICTLY older than STALE_DRIVER_S from both the
 * GEO set and the timestamp ZSET. A silent driver disappears from matching
 * within one sweep; a driver exactly at the boundary survives (Redis
 * `(cutoff` exclusive-bound semantics).
 */
import { requireEnv } from '../http/api';
import type { GeoClient } from './geo-client';
import { RedisGeoClient } from './redis-geo-client';

export async function sweep(geo: GeoClient, nowMs: number, staleSeconds: number): Promise<string[]> {
  const stale = await geo.membersStalerThan(nowMs - staleSeconds * 1000);
  if (stale.length > 0) {
    await geo.evict(stale);
  }
  return stale;
}

let geoSingleton: GeoClient | undefined;

export async function handler(): Promise<{ evicted: number }> {
  const geo = (geoSingleton ??= RedisGeoClient.fromEndpoint(requireEnv('REDIS_ENDPOINT')));
  const evicted = await sweep(geo, Date.now(), Number(requireEnv('STALE_DRIVER_S')));
  if (evicted.length > 0) {
    console.log(JSON.stringify({ msg: 'evicted stale drivers', count: evicted.length, driverIds: evicted }));
  }
  return { evicted: evicted.length };
}
