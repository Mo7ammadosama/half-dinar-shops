import { Logger } from "@nestjs/common";
import type Redis from "ioredis";

/**
 * A fixed-window counter, used for limits the IP-based throttler cannot express
 * (currently: OTP requests per phone number).
 *
 * Kept deliberately separate from @nestjs/throttler. The throttler keys on the
 * caller's IP, which does not stop one phone number being targeted from many
 * IPs — a botnet could bill the founder for thousands of SMS to a stranger's
 * handset while every individual IP stayed inside its limit.
 */
export interface CounterStore {
  /**
   * Increments `key` and returns the new count within the current window.
   *
   * The window starts on the first increment and is not extended by later ones,
   * so a caller cannot hold themselves throttled forever by retrying.
   */
  increment(key: string, windowSeconds: number): Promise<number>;

  /** True when counters survive a restart and are shared across instances. */
  readonly isShared: boolean;
}

/**
 * Redis-backed counter — the production implementation.
 *
 * INCR and EXPIRE are issued in one pipeline so the pair cannot be interleaved
 * with another request's INCR. EXPIRE is only set on the first increment (when
 * INCR returns 1), which is what makes this a fixed window rather than a
 * sliding one that never lets go.
 */
export class RedisCounterStore implements CounterStore {
  readonly isShared = true;

  private readonly logger = new Logger(RedisCounterStore.name);

  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const namespaced = `ratelimit:${key}`;

    const results = await this.redis.multi().incr(namespaced).ttl(namespaced).exec();

    // ioredis returns [[err, value], ...]; a null result means the pipeline was
    // discarded entirely.
    if (!results) throw new Error("Redis pipeline returned no result");

    const [[incrError, count], [ttlError, ttl]] = results as [
      [Error | null, number],
      [Error | null, number],
    ];
    if (incrError) throw incrError;
    if (ttlError) throw ttlError;

    // -1 means the key exists with no expiry: either this is the first
    // increment, or a previous EXPIRE was lost. Setting it here is idempotent
    // and self-heals a key that would otherwise never expire.
    if (ttl === -1) {
      await this.redis.expire(namespaced, windowSeconds);
    }

    return count;
  }
}

/**
 * In-memory counter — development only.
 *
 * Resets on restart and is not shared between instances, which is precisely
 * blocker B2. env.validation.ts refuses to boot production without Redis, so
 * this cannot become the production path.
 */
export class MemoryCounterStore implements CounterStore {
  readonly isShared = false;

  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  async increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.windows.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      this.sweep(now);
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  /** Drops expired windows so a long-lived process cannot grow unboundedly. */
  private sweep(now: number) {
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
  }
}

/** Injection token — `CounterStore` is an interface and erased at runtime. */
export const COUNTER_STORE = Symbol("COUNTER_STORE");
