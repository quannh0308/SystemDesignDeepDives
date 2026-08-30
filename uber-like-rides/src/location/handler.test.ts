import { describe, expect, it } from 'vitest';
import { parseBbox, inBbox } from './bbox';
import { InMemoryGeoClient } from './geo-client.fake';
import { handlePing, type PingDeps } from './handler';

// Berlin bbox from lld.md §7
const BBOX = parseBbox('52.35,13.20,52.60,13.55');

function deps(geo = new InMemoryGeoClient()): PingDeps & { geo: InMemoryGeoClient } {
  return { geo, bbox: BBOX, now: () => 1_000_000 };
}

describe('CITY_BBOX parsing and containment', () => {
  it('parses latMin,lngMin,latMax,lngMax', () => {
    expect(BBOX).toEqual({ latMin: 52.35, lngMin: 13.2, latMax: 52.6, lngMax: 13.55 });
  });

  it('rejects malformed or inverted bboxes', () => {
    expect(() => parseBbox('52.35,13.20,52.60')).toThrow();
    expect(() => parseBbox('52.60,13.20,52.35,13.55')).toThrow();
    expect(() => parseBbox('a,b,c,d')).toThrow();
  });

  it('bbox edges are inclusive', () => {
    expect(inBbox({ lat: 52.35, lng: 13.2 }, BBOX)).toBe(true);
    expect(inBbox({ lat: 52.6, lng: 13.55 }, BBOX)).toBe(true);
  });
});

describe('POST /drivers/location (task 3.2)', () => {
  it('rejects a ping outside the city bbox with 400 BAD_COORDS', async () => {
    const d = deps();
    const res = await handlePing(d, { role: 'driver', id: 'driver-1' }, { lat: 48.13, lng: 11.58 }); // Munich
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.code).toBe('BAD_COORDS');
    expect(d.geo.has('driver-1')).toBe(false);
  });

  it('rejects non-numeric coordinates', async () => {
    const res = await handlePing(deps(), { role: 'driver', id: 'driver-1' }, { lat: 'x', lng: 13.4 });
    expect(res.statusCode).toBe(400);
  });

  it('rejects riders — location reporting is driver-only', async () => {
    const res = await handlePing(deps(), { role: 'rider', id: 'rider-1' }, { lat: 52.5, lng: 13.4 });
    expect(res.statusCode).toBe(403);
  });

  it('records a valid ping under the token identity, never a body-supplied id', async () => {
    const d = deps();
    const res = await handlePing(
      d,
      { role: 'driver', id: 'driver-token' },
      { lat: 52.5, lng: 13.4, driverId: 'driver-spoofed' },
    );
    expect(res.statusCode).toBe(200);
    expect(d.geo.has('driver-token')).toBe(true);
    expect(d.geo.has('driver-spoofed')).toBe(false);
    expect(d.geo.pings.get('driver-token')).toEqual({ lng: 13.4, lat: 52.5, atMs: 1_000_000 });
  });
});
