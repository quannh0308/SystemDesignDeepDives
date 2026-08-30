/**
 * Routing (lld.md §0 substitution: haversine × city-speed model stands in for
 * a real maps provider). haversineKm is also the distance model of the
 * in-memory geo fake, so unit-test distances and fare distances agree.
 */
import type { Point } from '../location/bbox';

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface Route {
  distanceKm: number;
  durationSeconds: number;
}

/**
 * The port (lld.md §1 SUPPORTING tiers): swap in a real maps adapter later
 * and the fare handler never changes.
 */
export interface RoutingPort {
  route(pickup: Point, destination: Point): Promise<Route>;
}

/** Lab city-speed model: straight-line distance at a flat urban average speed. */
const CITY_SPEED_KMH = 24;

export class CityRouting implements RoutingPort {
  async route(pickup: Point, destination: Point): Promise<Route> {
    const distanceKm = haversineKm(pickup, destination);
    return { distanceKm, durationSeconds: Math.round((distanceKm / CITY_SPEED_KMH) * 3600) };
  }
}
