import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import {
  COUNTER_STORE,
  MemoryCounterStore,
  RedisCounterStore,
  type CounterStore,
} from "./counter-store";
import { PhoneRateLimiter } from "./phone-rate-limiter";

/** Injection token for the shared Redis connection (null when not configured). */
export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

/**
 * Builds the shared Redis connection, or null in development.
 *
 * One connection is shared by the throttler storage and the phone limiter —
 * two clients to the same server would double the connection count for no gain.
 */
export function createRedisClient(config: ConfigService): Redis | null {
  const url = config.get<string>("REDIS_URL")?.trim();
  if (!url) return null;

  const logger = new Logger("RateLimitModule");

  const redis = new Redis(url, {
    // Bounded retries, but the offline queue stays ON (ioredis's default).
    //
    // Turning the offline queue off looks like "fail fast", but it also rejects
    // every command issued before the socket finishes connecting — so for the
    // first moments after each boot, and during any brief reconnect, the phone
    // limiter would error, fail open, and silently stop enforcing. Queueing
    // rides out those blips; maxRetriesPerRequest still makes a genuinely dead
    // server error out promptly rather than stalling the login request.
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
  });

  redis.on("error", (error) => {
    // Logged, not thrown: an unhandled 'error' event would take the process
    // down, turning a degraded rate limiter into a full outage.
    logger.error(`Redis connection error: ${error.message}`);
  });
  redis.on("connect", () => logger.log(`Rate limiting: redis (${url.replace(/:[^:@]*@/, ":***@")})`));

  return redis;
}

export function createCounterStore(redis: Redis | null): CounterStore {
  if (redis) return new RedisCounterStore(redis);

  new Logger("RateLimitModule").warn(
    "Rate limiting: in-memory — limits RESET ON RESTART and are not shared between " +
      "instances. Development only. See docs/REDIS_SETUP.md to go live.",
  );
  return new MemoryCounterStore();
}

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, inject: [ConfigService], useFactory: createRedisClient },
    { provide: COUNTER_STORE, inject: [REDIS_CLIENT], useFactory: createCounterStore },
    PhoneRateLimiter,
  ],
  exports: [REDIS_CLIENT, COUNTER_STORE, PhoneRateLimiter],
})
export class RateLimitModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  /**
   * Closes the connection on shutdown.
   *
   * Without this an open ioredis socket keeps the event loop alive, so the Jest
   * process hangs after the tests finish instead of exiting.
   */
  async onApplicationShutdown() {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      // Already closed, or the server went away — nothing left to clean up.
      this.redis.disconnect();
    }
  }
}
