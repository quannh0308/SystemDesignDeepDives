/**
 * Synthetic city model (task 6.1) on the real city bounding box: a street
 * grid (~200 m spacing) that every generated point snaps to — pickups and
 * driver positions land "on roads", not in the river — plus two named zones
 * (downtown, airport) that the fleet placement distributions cluster around.
 */
import { parseBbox, type Bbox, type Point } from '../location/bbox';
import { between, gaussian, type Rng } from './rng';

export interface City {
  bbox: Bbox;
  /** Street-grid spacing: ~220 m lat, ~200 m lng at Berlin's latitude. */
  latStep: number;
  lngStep: number;
  downtown: Point;
  airport: Point;
}

export function makeCity(bboxRaw: string): City {
  const bbox = parseBbox(bboxRaw);
  const latSpan = bbox.latMax - bbox.latMin;
  const lngSpan = bbox.lngMax - bbox.lngMin;
  return {
    bbox,
    latStep: 0.002,
    lngStep: 0.003,
    downtown: { lat: bbox.latMin + 0.5 * latSpan, lng: bbox.lngMin + 0.5 * lngSpan },
    airport: { lat: bbox.latMin + 0.15 * latSpan, lng: bbox.lngMin + 0.85 * lngSpan },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Snap to the nearest grid intersection, clamped inside the bbox. */
export function snapToGrid(city: City, point: Point): Point {
  const lat = city.bbox.latMin + Math.round((point.lat - city.bbox.latMin) / city.latStep) * city.latStep;
  const lng = city.bbox.lngMin + Math.round((point.lng - city.bbox.lngMin) / city.lngStep) * city.lngStep;
  return {
    lat: clamp(Number(lat.toFixed(6)), city.bbox.latMin, city.bbox.latMax),
    lng: clamp(Number(lng.toFixed(6)), city.bbox.lngMin, city.bbox.lngMax),
  };
}

export function uniformPoint(city: City, rng: Rng): Point {
  return snapToGrid(city, {
    lat: between(rng, city.bbox.latMin, city.bbox.latMax),
    lng: between(rng, city.bbox.lngMin, city.bbox.lngMax),
  });
}

/** Gaussian cluster around a center (σ in degrees), snapped and clamped. */
export function clusteredPoint(city: City, rng: Rng, center: Point, sigmaLat: number, sigmaLng: number): Point {
  return snapToGrid(city, {
    lat: center.lat + gaussian(rng) * sigmaLat,
    lng: center.lng + gaussian(rng) * sigmaLng,
  });
}
