/**
 * Rider demand generator (task 6.3). Three patterns:
 * - steady: Poisson arrivals (exponential inter-arrival gaps) at a flat rate;
 * - rush: inhomogeneous Poisson ramping from rate/4 up to the full rate
 *   across the window (thinning method);
 * - hotspot: N requests from ONE neighborhood inside M minutes with
 *   destinations spread citywide — the lab-scale shape of the design's
 *   100k-same-metro burst (hld.md §2.2).
 * Times are millisecond offsets from run start, so fixtures replay at any
 * wall-clock time.
 */
import type { Point } from '../location/bbox';
import { clusteredPoint, uniformPoint, type City } from './city';
import type { Rng } from './rng';

export type DemandPattern = 'steady' | 'rush' | 'hotspot';

export interface DemandRequest {
  /** Offset from run start, ms. */
  atMs: number;
  pickup: Point;
  dest: Point;
}

export interface DemandOptions {
  pattern: DemandPattern;
  durationMin: number;
  /** steady: flat rate · rush: peak rate reached at the end of the window. */
  ratePerMin: number;
  /** hotspot only: total requests in the burst. */
  burst: number;
}

function poissonArrivals(rng: Rng, durationMs: number, ratePerMs: number, accept: (tMs: number) => boolean): number[] {
  const times: number[] = [];
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng()) / ratePerMs; // exponential gap
    if (t >= durationMs) return times;
    if (accept(t)) times.push(Math.round(t));
  }
}

export function generateDemand(city: City, rng: Rng, options: DemandOptions): DemandRequest[] {
  const durationMs = options.durationMin * 60_000;
  const peakPerMs = options.ratePerMin / 60_000;

  let times: number[];
  let pickupOf: () => Point;

  switch (options.pattern) {
    case 'steady':
      times = poissonArrivals(rng, durationMs, peakPerMs, () => true);
      pickupOf = () => uniformPoint(city, rng);
      break;
    case 'rush': {
      // Thinning: simulate at peak, keep with probability λ(t)/peak where λ ramps rate/4 → rate.
      const acceptAt = (t: number) => rng() < 0.25 + 0.75 * (t / durationMs);
      times = poissonArrivals(rng, durationMs, peakPerMs, acceptAt);
      pickupOf = () => uniformPoint(city, rng);
      break;
    }
    case 'hotspot': {
      const epicenter = uniformPoint(city, rng); // one neighborhood per fixture
      times = Array.from({ length: options.burst }, () => Math.round(rng() * durationMs)).sort((a, b) => a - b);
      pickupOf = () => clusteredPoint(city, rng, epicenter, 0.003, 0.0045); // σ ≈ 330 m
      break;
    }
  }

  return times.map((atMs) => ({ atMs, pickup: pickupOf(), dest: uniformPoint(city, rng) }));
}
