import { describe, expect, it } from 'vitest';
import { InMemoryGeoClient } from './geo-client.fake';
import { sweep } from './sweeper';

const NOW = 1_000_000_000;
const STALE_S = 30;

describe('stale sweeper (task 3.3)', () => {
  it('evicts exactly the members stale >30 s — from both structures', async () => {
    const geo = new InMemoryGeoClient();
    await geo.recordPing('fresh-10s', 13.4, 52.5, NOW - 10_000);
    await geo.recordPing('fresh-29s', 13.41, 52.51, NOW - 29_000);
    await geo.recordPing('stale-31s', 13.42, 52.52, NOW - 31_000);
    await geo.recordPing('stale-45s', 13.43, 52.53, NOW - 45_000);

    const evicted = await sweep(geo, NOW, STALE_S);

    expect(evicted.sort()).toEqual(['stale-31s', 'stale-45s']);
    expect(geo.has('fresh-10s')).toBe(true);
    expect(geo.has('fresh-29s')).toBe(true);
    expect(geo.has('stale-31s')).toBe(false);
    expect(geo.has('stale-45s')).toBe(false);
  });

  it('a member exactly at the 30 s boundary survives (strict bound, Redis "(cutoff" semantics)', async () => {
    const geo = new InMemoryGeoClient();
    await geo.recordPing('boundary', 13.4, 52.5, NOW - 30_000);
    const evicted = await sweep(geo, NOW, STALE_S);
    expect(evicted).toEqual([]);
    expect(geo.has('boundary')).toBe(true);
  });

  it('no stale members → no eviction call, empty result', async () => {
    const geo = new InMemoryGeoClient();
    await geo.recordPing('fresh', 13.4, 52.5, NOW - 1_000);
    await expect(sweep(geo, NOW, STALE_S)).resolves.toEqual([]);
  });
});
