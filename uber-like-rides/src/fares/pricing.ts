/**
 * Fare pricing (hld.md §6.1): base + per-km + per-minute, EUR cents. Strictly
 * increasing in both distance and duration — a longer ride is never cheaper
 * (pinned by test).
 */
const BASE_CENTS = 300;
const PER_KM_CENTS = 120;
const PER_MINUTE_CENTS = 25;

export function priceCents(distanceKm: number, durationSeconds: number): number {
  return Math.round(BASE_CENTS + PER_KM_CENTS * distanceKm + (PER_MINUTE_CENTS / 60) * durationSeconds);
}
