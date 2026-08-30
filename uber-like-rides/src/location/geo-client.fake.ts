/**
 * In-memory GeoClient with real semantics (strict staleness bound, distance
 * ordering) — the test double for every CORE module touching geo state.
 * Imported by tests only; never bundled into a Lambda.
 */
import { haversineKm } from '../fares/routing';
import type { GeoCandidate, GeoClient } from './geo-client';

interface StoredPing {
  lng: number;
  lat: number;
  atMs: number;
}

export class InMemoryGeoClient implements GeoClient {
  readonly pings = new Map<string, StoredPing>();

  async recordPing(driverId: string, lng: number, lat: number, atMs: number): Promise<void> {
    this.pings.set(driverId, { lng, lat, atMs });
  }

  async membersStalerThan(cutoffMs: number): Promise<string[]> {
    // Redis `(cutoff` bound is exclusive: score < cutoff, never ==.
    return [...this.pings.entries()].filter(([, p]) => p.atMs < cutoffMs).map(([id]) => id);
  }

  async evict(driverIds: string[]): Promise<void> {
    for (const id of driverIds) this.pings.delete(id);
  }

  async searchRadiusKm(lng: number, lat: number, radiusKm: number, limit: number): Promise<GeoCandidate[]> {
    return [...this.pings.entries()]
      .map(([driverId, p]) => ({
        driverId,
        distanceKm: haversineKm({ lat, lng }, { lat: p.lat, lng: p.lng }),
      }))
      .filter((c) => c.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);
  }

  has(driverId: string): boolean {
    return this.pings.has(driverId);
  }
}
