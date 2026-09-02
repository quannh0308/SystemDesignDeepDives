/**
 * Fixture CLI (task 6.4): `npm run gen -- --seed 42 --drivers 200 --profile rush`
 * writes a versioned, replayable world under `fixtures/` (lld.md §8 schema).
 * Same flags ⇒ byte-identical fixture; the filename carries the recipe.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG } from '../../cdk/config';
import { generateDemand, type DemandPattern, type DemandRequest } from './demand';
import { generateFleet, type FleetDriver, type Placement } from './fleet';
import { makeCity, type City } from './city';
import { createRng } from './rng';

export interface FixtureOptions {
  seed: number;
  drivers: number;
  placement: Placement;
  profile: DemandPattern;
  minutes: number;
  ratePerMin: number;
  burst: number;
}

export interface Fixture {
  version: 1;
  seed: number;
  profile: DemandPattern;
  placement: Placement;
  city: City;
  drivers: FleetDriver[];
  demand: DemandRequest[];
}

export const DEFAULTS: FixtureOptions = {
  seed: 42,
  drivers: 200,
  placement: 'uniform',
  profile: 'steady',
  minutes: 10,
  ratePerMin: 6,
  burst: 100,
};

export function buildFixture(options: FixtureOptions): Fixture {
  const city = makeCity(CONFIG.CITY_BBOX);
  const rng = createRng(options.seed);
  return {
    version: 1,
    seed: options.seed,
    profile: options.profile,
    placement: options.placement,
    city,
    drivers: generateFleet(city, rng, { count: options.drivers, placement: options.placement }),
    demand: generateDemand(city, rng, {
      pattern: options.profile,
      durationMin: options.minutes,
      ratePerMin: options.ratePerMin,
      burst: options.burst,
    }),
  };
}

export function fixtureFileName(options: FixtureOptions): string {
  return `${options.profile}-${options.placement}-seed${options.seed}-drivers${options.drivers}.json`;
}

function parseCliOptions(argv: string[]): FixtureOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: 'string' },
      drivers: { type: 'string' },
      placement: { type: 'string' },
      profile: { type: 'string' },
      minutes: { type: 'string' },
      rate: { type: 'string' },
      burst: { type: 'string' },
    },
  });
  return {
    seed: values.seed ? Number(values.seed) : DEFAULTS.seed,
    drivers: values.drivers ? Number(values.drivers) : DEFAULTS.drivers,
    placement: (values.placement as Placement | undefined) ?? DEFAULTS.placement,
    profile: (values.profile as DemandPattern | undefined) ?? DEFAULTS.profile,
    minutes: values.minutes ? Number(values.minutes) : DEFAULTS.minutes,
    ratePerMin: values.rate ? Number(values.rate) : DEFAULTS.ratePerMin,
    burst: values.burst ? Number(values.burst) : DEFAULTS.burst,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliOptions(process.argv.slice(2));
  const fixture = buildFixture(options);
  const dir = resolve(process.cwd(), 'fixtures');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, fixtureFileName(options));
  writeFileSync(path, JSON.stringify(fixture, null, 2));
  console.log(
    `wrote ${path} — ${fixture.drivers.length} drivers (${options.placement}), ` +
      `${fixture.demand.length} requests (${options.profile}, ${options.minutes} min)`,
  );
}
