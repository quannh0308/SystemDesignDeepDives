/** City bounding box (lld.md §7 CITY_BBOX): `latMin,lngMin,latMax,lngMax`. */

export interface Bbox {
  latMin: number;
  lngMin: number;
  latMax: number;
  lngMax: number;
}

export interface Point {
  lat: number;
  lng: number;
}

export function parseBbox(raw: string): Bbox {
  const parts = raw.split(',').map(Number);
  const [latMin, lngMin, latMax, lngMax] = parts;
  if (
    parts.length !== 4 ||
    parts.some(Number.isNaN) ||
    latMin === undefined ||
    lngMin === undefined ||
    latMax === undefined ||
    lngMax === undefined ||
    latMin >= latMax ||
    lngMin >= lngMax
  ) {
    throw new Error(`Invalid CITY_BBOX: ${raw}`);
  }
  return { latMin, lngMin, latMax, lngMax };
}

export function inBbox(point: Point, bbox: Bbox): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= bbox.latMin &&
    point.lat <= bbox.latMax &&
    point.lng >= bbox.lngMin &&
    point.lng <= bbox.lngMax
  );
}
