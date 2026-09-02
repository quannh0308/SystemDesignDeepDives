/**
 * Deterministic RNG for fixture generation (task 6, lld.md §8): mulberry32 —
 * tiny, fast, and stable across platforms, so the same seed always produces
 * the same world and every test run is comparable. HARNESS tier: never
 * deployed, never imported by runtime code.
 */

export type Rng = () => number;

/** Returns a generator of floats in [0, 1), fully determined by the seed. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function pickWeighted<T>(rng: Rng, entries: Array<{ weight: number; value: T }>): T {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.value;
  }
  return entries[entries.length - 1]!.value;
}

/** Standard normal via Box–Muller — used for downtown/airport clustering. */
export function gaussian(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON); // avoid ln(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
