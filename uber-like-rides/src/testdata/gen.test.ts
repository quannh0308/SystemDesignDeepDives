import { describe, expect, it } from 'vitest';
import { buildFixture, DEFAULTS, fixtureFileName } from './gen';

describe('fixture builder (task 6.4, lld.md §8 schema)', () => {
  it('same options ⇒ byte-identical fixture (full-world determinism)', () => {
    const a = buildFixture(DEFAULTS);
    const b = buildFixture(DEFAULTS);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('carries the §8 schema: version, seed, city, drivers[], demand[]', () => {
    const fixture = buildFixture({ ...DEFAULTS, drivers: 10, minutes: 2 });
    expect(fixture.version).toBe(1);
    expect(fixture.seed).toBe(42);
    expect(fixture.city.bbox).toEqual({ latMin: 52.35, lngMin: 13.2, latMax: 52.6, lngMax: 13.55 });
    expect(fixture.drivers).toHaveLength(10);
    expect(fixture.drivers[0]).toMatchObject({
      id: 'driver-0001',
      start: { lat: expect.any(Number), lng: expect.any(Number) },
      profile: {
        acceptP: expect.any(Number),
        thinkMs: expect.any(Number),
        cadenceS: expect.any(Number),
        shiftMin: expect.any(Number),
      },
    });
    for (const request of fixture.demand) {
      expect(request).toMatchObject({ atMs: expect.any(Number), pickup: expect.anything(), dest: expect.anything() });
    }
  });

  it('changing the seed changes the world', () => {
    const a = buildFixture(DEFAULTS);
    const b = buildFixture({ ...DEFAULTS, seed: 43 });
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it('filename carries the recipe', () => {
    expect(fixtureFileName({ ...DEFAULTS, profile: 'rush', seed: 7, drivers: 50 })).toBe(
      'rush-uniform-seed7-drivers50.json',
    );
  });
});
