import { describe, expect, it } from 'vitest';
import { InMemoryGeoClient } from '../location/geo-client.fake';
import { findCandidates, type ActiveRideLookup } from './candidates';

const PICKUP = { lat: 52.52, lng: 13.405 }; // Alexanderplatz-ish
const NOW = 1_000_000;

function lookup(activeDrivers: string[] = []): ActiveRideLookup {
  return { hasActiveRide: async (driverId) => activeDrivers.includes(driverId) };
}

async function seededGeo(): Promise<InMemoryGeoClient> {
  const geo = new InMemoryGeoClient();
  await geo.recordPing('near-500m', 13.4095, 52.523, NOW); // ~0.45 km
  await geo.recordPing('mid-2km', 13.38, 52.51, NOW); // ~2.0 km
  await geo.recordPing('far-4km', 13.35, 52.5, NOW); // ~4.3 km
  await geo.recordPing('outside-8km', 13.29, 52.55, NOW); // ~8.5 km — beyond radius
  return geo;
}

describe('candidate finder (task 3.4)', () => {
  it('returns in-radius drivers nearest first, drops out-of-radius', async () => {
    const result = await findCandidates(await seededGeo(), lookup(), {
      pickup: PICKUP,
      excluded: [],
      radiusKm: 5,
      limit: 10,
    });
    expect(result.map((c) => c.driverId)).toEqual(['near-500m', 'mid-2km', 'far-4km']);
    expect(result[0]!.distanceKm).toBeLessThan(result[1]!.distanceKm);
    expect(result[1]!.distanceKm).toBeLessThan(result[2]!.distanceKm);
  });

  it('honors exclusions (drivers already tried for this ride)', async () => {
    const result = await findCandidates(await seededGeo(), lookup(), {
      pickup: PICKUP,
      excluded: ['near-500m', 'far-4km'],
      radiusKm: 5,
      limit: 10,
    });
    expect(result.map((c) => c.driverId)).toEqual(['mid-2km']);
  });

  it('drops drivers with an active ride', async () => {
    const result = await findCandidates(await seededGeo(), lookup(['near-500m']), {
      pickup: PICKUP,
      excluded: [],
      radiusKm: 5,
      limit: 10,
    });
    expect(result.map((c) => c.driverId)).toEqual(['mid-2km', 'far-4km']);
  });

  it('respects the search limit before filtering (lld.md: GEOSEARCH … COUNT limit)', async () => {
    const result = await findCandidates(await seededGeo(), lookup(), {
      pickup: PICKUP,
      excluded: [],
      radiusKm: 5,
      limit: 2,
    });
    expect(result.map((c) => c.driverId)).toEqual(['near-500m', 'mid-2km']);
  });

  it('all candidates excluded or active → empty (state machine branches to MarkFailed)', async () => {
    const result = await findCandidates(await seededGeo(), lookup(['mid-2km']), {
      pickup: PICKUP,
      excluded: ['near-500m', 'far-4km'],
      radiusKm: 5,
      limit: 10,
    });
    expect(result).toEqual([]);
  });
});
