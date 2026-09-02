/**
 * Driver fleet generator (task 6.2): where drivers start (uniform |
 * downtown-weighted | airport-cluster) and how they behave (accept
 * probability, think time, ping cadence per hld.md Deep Dive 9.6, shift
 * length). Profiles are drawn from three readable archetypes rather than
 * free-floating randoms, so a fixture is skimmable by a human.
 */
import type { Point } from '../location/bbox';
import { clusteredPoint, uniformPoint, type City } from './city';
import { between, pickWeighted, type Rng } from './rng';

export type Placement = 'uniform' | 'downtown' | 'airport';

export interface DriverProfile {
  archetype: 'eager' | 'steady' | 'picky';
  /** Probability the driver accepts an offer (sim rolls against this). */
  acceptP: number;
  /** Delay before answering an offer. */
  thinkMs: number;
  /** Location ping interval, seconds (adaptive cadence — Deep Dive 9.6). */
  cadenceS: number;
  /** How long the driver stays on shift. */
  shiftMin: number;
}

export interface FleetDriver {
  id: string;
  start: Point;
  profile: DriverProfile;
}

interface Archetype {
  archetype: DriverProfile['archetype'];
  acceptP: number;
  thinkMs: readonly [number, number];
  cadenceS: number;
}

const ARCHETYPES: Array<{ weight: number; value: Archetype }> = [
  { weight: 4, value: { archetype: 'eager', acceptP: 0.9, thinkMs: [500, 1500], cadenceS: 4 } },
  { weight: 4, value: { archetype: 'steady', acceptP: 0.65, thinkMs: [1000, 3000], cadenceS: 5 } },
  { weight: 2, value: { archetype: 'picky', acceptP: 0.35, thinkMs: [2000, 6000], cadenceS: 6 } },
];

function startPoint(city: City, rng: Rng, placement: Placement): Point {
  switch (placement) {
    case 'uniform':
      return uniformPoint(city, rng);
    case 'downtown':
      return clusteredPoint(city, rng, city.downtown, 0.015, 0.022); // σ ≈ 1.7 km
    case 'airport':
      return clusteredPoint(city, rng, city.airport, 0.004, 0.006); // σ ≈ 450 m — tight rank
  }
}

export function generateFleet(
  city: City,
  rng: Rng,
  options: { count: number; placement: Placement },
): FleetDriver[] {
  return Array.from({ length: options.count }, (_, i) => {
    const archetype = pickWeighted(rng, ARCHETYPES);
    return {
      id: `driver-${String(i + 1).padStart(4, '0')}`,
      start: startPoint(city, rng, options.placement),
      profile: {
        archetype: archetype.archetype,
        acceptP: archetype.acceptP,
        thinkMs: Math.round(between(rng, archetype.thinkMs[0], archetype.thinkMs[1])),
        cadenceS: archetype.cadenceS,
        shiftMin: Math.round(between(rng, 60, 480)),
      },
    };
  });
}
