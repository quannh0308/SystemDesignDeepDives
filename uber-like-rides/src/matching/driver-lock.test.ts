import { describe, expect, it } from 'vitest';
import { InMemoryLockClient } from './driver-lock.fake';

describe('driver lock (task 4.3/4.5)', () => {
  it('both-matchers-race: exactly one ride wins the driver', async () => {
    const locks = new InMemoryLockClient(() => 1000);
    expect(await locks.acquire('driver-1', 'ride-A', 10_000)).toBe(true);
    expect(await locks.acquire('driver-1', 'ride-B', 10_000)).toBe(false);
    expect(locks.holder('driver-1')).toBe('ride-A');
  });

  it('owner-checked release: the loser cannot free the winner’s lock', async () => {
    const locks = new InMemoryLockClient(() => 1000);
    await locks.acquire('driver-1', 'ride-A', 10_000);
    await locks.release('driver-1', 'ride-B'); // not the owner — no-op
    expect(locks.holder('driver-1')).toBe('ride-A');
    await locks.release('driver-1', 'ride-A');
    expect(locks.holder('driver-1')).toBeUndefined();
  });

  it('lock self-expires after its TTL — a crashed matcher never wedges a driver', async () => {
    let now = 1000;
    const locks = new InMemoryLockClient(() => now);
    await locks.acquire('driver-1', 'ride-A', 10_000);
    now = 10_999;
    expect(await locks.acquire('driver-1', 'ride-B', 10_000)).toBe(false);
    now = 11_001;
    expect(await locks.acquire('driver-1', 'ride-B', 10_000)).toBe(true);
    expect(locks.holder('driver-1')).toBe('ride-B');
  });
});
