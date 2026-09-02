import { describe, expect, it } from 'vitest';
import { haversineKm } from '../fares/routing';
import { inBbox } from '../location/bbox';
import { makeCity, snapToGrid, uniformPoint } from './city';
import { generateDemand } from './demand';
import { generateFleet } from './fleet';
import { createRng } from './rng';

const CITY = makeCity('52.35,13.20,52.60,13.55');

describe('seeded rng', () => {
  it('same seed ⇒ identical sequence · different seed ⇒ different sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 10 }, a);
    expect(Array.from({ length: 10 }, b)).toEqual(seqA);
    expect(Array.from({ length: 10 }, c)).not.toEqual(seqA);
  });

  it('values stay in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('city model (task 6.1)', () => {
  it('grid snap puts points on grid intersections inside the bbox', () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i++) {
      const p = uniformPoint(CITY, rng);
      expect(inBbox(p, CITY.bbox)).toBe(true);
      const latSteps = (p.lat - CITY.bbox.latMin) / CITY.latStep;
      const lngSteps = (p.lng - CITY.bbox.lngMin) / CITY.lngStep;
      expect(Math.abs(latSteps - Math.round(latSteps))).toBeLessThan(1e-3);
      expect(Math.abs(lngSteps - Math.round(lngSteps))).toBeLessThan(1e-3);
    }
  });

  it('snap clamps out-of-bbox points back inside', () => {
    const snapped = snapToGrid(CITY, { lat: 99, lng: -99 });
    expect(inBbox(snapped, CITY.bbox)).toBe(true);
  });

  it('named zones sit inside the bbox', () => {
    expect(inBbox(CITY.downtown, CITY.bbox)).toBe(true);
    expect(inBbox(CITY.airport, CITY.bbox)).toBe(true);
  });
});

describe('fleet generator (task 6.2)', () => {
  it('deterministic: same seed ⇒ deep-equal fleet', () => {
    const fleetA = generateFleet(CITY, createRng(42), { count: 50, placement: 'downtown' });
    const fleetB = generateFleet(CITY, createRng(42), { count: 50, placement: 'downtown' });
    expect(fleetB).toEqual(fleetA);
  });

  it('every driver starts in-bbox with a profile inside the archetype ranges', () => {
    const fleet = generateFleet(CITY, createRng(9), { count: 300, placement: 'uniform' });
    expect(fleet).toHaveLength(300);
    expect(new Set(fleet.map((d) => d.id)).size).toBe(300); // ids unique
    for (const driver of fleet) {
      expect(inBbox(driver.start, CITY.bbox)).toBe(true);
      expect(driver.profile.acceptP).toBeGreaterThan(0);
      expect(driver.profile.acceptP).toBeLessThanOrEqual(1);
      expect(driver.profile.thinkMs).toBeGreaterThanOrEqual(500);
      expect(driver.profile.thinkMs).toBeLessThanOrEqual(6000);
      expect(driver.profile.cadenceS).toBeGreaterThanOrEqual(4);
      expect(driver.profile.cadenceS).toBeLessThanOrEqual(6);
      expect(driver.profile.shiftMin).toBeGreaterThanOrEqual(60);
      expect(driver.profile.shiftMin).toBeLessThanOrEqual(480);
    }
  });

  it('downtown placement clusters: mean distance to center well under uniform placement', () => {
    const downtown = generateFleet(CITY, createRng(5), { count: 200, placement: 'downtown' });
    const uniform = generateFleet(CITY, createRng(5), { count: 200, placement: 'uniform' });
    const meanDist = (fleet: typeof downtown) =>
      fleet.reduce((sum, d) => sum + haversineKm(d.start, CITY.downtown), 0) / fleet.length;
    expect(meanDist(downtown)).toBeLessThan(meanDist(uniform) / 2);
  });

  it('airport placement is a tight rank: 90% of drivers within 1.5 km of the airport', () => {
    const fleet = generateFleet(CITY, createRng(5), { count: 200, placement: 'airport' });
    const near = fleet.filter((d) => haversineKm(d.start, CITY.airport) <= 1.5);
    expect(near.length / fleet.length).toBeGreaterThan(0.9);
  });
});

describe('demand generator (task 6.3)', () => {
  it('deterministic: same seed ⇒ deep-equal demand', () => {
    const opts = { pattern: 'steady' as const, durationMin: 10, ratePerMin: 6, burst: 0 };
    expect(generateDemand(CITY, createRng(42), opts)).toEqual(generateDemand(CITY, createRng(42), opts));
  });

  it('steady: Poisson count near rate × duration, times sorted within the window, points in-bbox', () => {
    const demand = generateDemand(CITY, createRng(11), {
      pattern: 'steady',
      durationMin: 30,
      ratePerMin: 6,
      burst: 0,
    });
    expect(demand.length).toBeGreaterThan(30 * 6 * 0.6); // loose Poisson bounds — no flake
    expect(demand.length).toBeLessThan(30 * 6 * 1.4);
    for (let i = 0; i < demand.length; i++) {
      const request = demand[i]!;
      expect(request.atMs).toBeGreaterThanOrEqual(0);
      expect(request.atMs).toBeLessThan(30 * 60_000);
      if (i > 0) expect(request.atMs).toBeGreaterThanOrEqual(demand[i - 1]!.atMs);
      expect(inBbox(request.pickup, CITY.bbox)).toBe(true);
      expect(inBbox(request.dest, CITY.bbox)).toBe(true);
    }
  });

  it('rush: the second half of the window carries clearly more arrivals than the first', () => {
    const demand = generateDemand(CITY, createRng(13), {
      pattern: 'rush',
      durationMin: 30,
      ratePerMin: 12,
      burst: 0,
    });
    const half = (30 * 60_000) / 2;
    const first = demand.filter((r) => r.atMs < half).length;
    const second = demand.filter((r) => r.atMs >= half).length;
    expect(second).toBeGreaterThan(first * 1.3);
  });

  it('hotspot: exactly N requests, pickups in ONE neighborhood, destinations spread citywide', () => {
    const demand = generateDemand(CITY, createRng(17), {
      pattern: 'hotspot',
      durationMin: 5,
      ratePerMin: 0,
      burst: 150,
    });
    expect(demand).toHaveLength(150);
    const center = demand[0]!.pickup;
    for (const request of demand) {
      expect(haversineKm(request.pickup, center)).toBeLessThan(2.5); // one neighborhood
      expect(request.atMs).toBeLessThan(5 * 60_000);
    }
    const spreadDests = demand.filter((r) => haversineKm(r.dest, center) > 2.5);
    expect(spreadDests.length).toBeGreaterThan(demand.length / 2);
  });
});
