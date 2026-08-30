import { describe, expect, it } from 'vitest';
import { CityRouting, haversineKm } from './routing';

describe('haversine against known distances (task 5.3)', () => {
  it('one degree of longitude at the equator ≈ 111.19 km', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 1);
  });

  it('one degree of latitude ≈ 111.19 km at any longitude', () => {
    expect(haversineKm({ lat: 52, lng: 13.4 }, { lat: 53, lng: 13.4 })).toBeCloseTo(111.19, 1);
  });

  it('one degree of longitude at Berlin latitude shrinks by cos(52.5°) ≈ 67.7 km', () => {
    expect(haversineKm({ lat: 52.5, lng: 13.0 }, { lat: 52.5, lng: 14.0 })).toBeCloseTo(67.7, 0);
  });

  it('Brandenburg Gate → Alexanderplatz ≈ 2.4 km', () => {
    const km = haversineKm({ lat: 52.5163, lng: 13.3777 }, { lat: 52.5219, lng: 13.4132 });
    expect(km).toBeGreaterThan(2.2);
    expect(km).toBeLessThan(2.7);
  });

  it('zero distance for identical points', () => {
    expect(haversineKm({ lat: 52.5, lng: 13.4 }, { lat: 52.5, lng: 13.4 })).toBe(0);
  });
});

describe('city-speed routing model', () => {
  it('duration = distance at 24 km/h', async () => {
    const route = await new CityRouting().route({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    // 111.19 km at 24 km/h ≈ 4.63 h ≈ 16 679 s
    expect(route.durationSeconds).toBeCloseTo((route.distanceKm / 24) * 3600, 0);
  });
});
