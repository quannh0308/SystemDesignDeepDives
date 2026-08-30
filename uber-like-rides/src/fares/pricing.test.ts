import { describe, expect, it } from 'vitest';
import { priceCents } from './pricing';

describe('pricing (task 5.3)', () => {
  it('longer ride is never cheaper — monotone in distance', () => {
    const distances = [0.5, 1, 2.4, 5, 8.7, 12, 20];
    const prices = distances.map((km) => priceCents(km, (km / 24) * 3600));
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
    }
  });

  it('slower ride is never cheaper — monotone in duration at fixed distance', () => {
    expect(priceCents(5, 1200)).toBeGreaterThan(priceCents(5, 600));
  });

  it('known value: 2 km at city speed (300 s) = 300 + 240 + 125 = 665 cents', () => {
    expect(priceCents(2, 300)).toBe(665);
  });

  it('prices are integer cents', () => {
    expect(Number.isInteger(priceCents(2.437, 731))).toBe(true);
  });
});
