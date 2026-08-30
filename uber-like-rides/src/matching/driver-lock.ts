/**
 * Driver offer lock (lld.md §4, hld.md Deep Dive 9.2): `SET lock:driver:{id}
 * <rideId> NX PX <ttl>` to acquire, Lua compare-and-delete to release — a
 * matcher can never release a lock another ride now holds. Zero retries and a
 * 2 s timeout on acquire: any failure counts as "driver busy, next candidate"
 * (fail toward liveness; correctness stays with the conditional writes).
 */
import { Redis } from 'ioredis';

export interface LockClient {
  /** True if this ride now holds the driver's lock. */
  acquire(driverId: string, rideId: string, ttlMs: number): Promise<boolean>;
  /** Releases only if this ride still owns the lock; otherwise a no-op. */
  release(driverId: string, rideId: string): Promise<void>;
}

const lockKey = (driverId: string) => `lock:driver:${driverId}`;

const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export class RedisLockClient implements LockClient {
  constructor(private readonly redis: Redis) {}

  static fromEndpoint(endpoint: string): RedisLockClient {
    const [host, port] = endpoint.split(':');
    return new RedisLockClient(
      new Redis({ host, port: Number(port ?? 6379), commandTimeout: 2000, maxRetriesPerRequest: 0, lazyConnect: true }),
    );
  }

  async acquire(driverId: string, rideId: string, ttlMs: number): Promise<boolean> {
    try {
      const reply = await this.redis.set(lockKey(driverId), rideId, 'PX', ttlMs, 'NX');
      return reply === 'OK';
    } catch {
      return false; // timeout/error = busy — next candidate
    }
  }

  async release(driverId: string, rideId: string): Promise<void> {
    await this.redis.eval(RELEASE_IF_OWNER, 1, lockKey(driverId), rideId);
  }
}
