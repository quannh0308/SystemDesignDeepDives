/** In-memory LockClient with real NX + TTL + owner-check semantics. Tests only. */
import type { LockClient } from './driver-lock';

interface HeldLock {
  rideId: string;
  expiresAtMs: number;
}

export class InMemoryLockClient implements LockClient {
  readonly locks = new Map<string, HeldLock>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(driverId: string, rideId: string, ttlMs: number): Promise<boolean> {
    const held = this.locks.get(driverId);
    if (held && held.expiresAtMs > this.now()) return false;
    this.locks.set(driverId, { rideId, expiresAtMs: this.now() + ttlMs });
    return true;
  }

  async release(driverId: string, rideId: string): Promise<void> {
    const held = this.locks.get(driverId);
    if (held && held.rideId === rideId) this.locks.delete(driverId);
  }

  holder(driverId: string): string | undefined {
    const held = this.locks.get(driverId);
    return held && held.expiresAtMs > this.now() ? held.rideId : undefined;
  }
}
