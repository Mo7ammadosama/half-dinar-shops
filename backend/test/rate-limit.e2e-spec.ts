import { Redis } from "ioredis";
import { HttpException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard } from "@nestjs/throttler";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import {
  MemoryCounterStore,
  RedisCounterStore,
  type CounterStore,
} from "../src/rate-limit/counter-store";
import { PhoneRateLimiter } from "../src/rate-limit/phone-rate-limiter";
import { createCounterStore, createRedisClient } from "../src/rate-limit/rate-limit.module";
import { PHONE_OTP_LIMIT } from "../src/config/rate-limits";
import { validateEnv } from "../src/config/env.validation";
import { productionEnv } from "./helpers";

/**
 * Persistent, shared rate limiting (launch blocker B2).
 *
 * These tests talk to the REAL Redis from docker-compose, deliberately.
 *
 * The rest of the suite overrides ThrottlerGuard so it does not throttle itself
 * — which means nothing else in this project would exercise the Redis path at
 * all. A mocked Redis here would test the mock, and B2's two claims (limits
 * survive a restart; limits are shared between instances) are precisely the
 * claims a mock cannot make. So: real server, real INCR, real TTL.
 */
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6380";

describe("Persistent rate limiting (blocker B2)", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    // Fail loudly if Redis is not up: a silently skipped test here would leave
    // B2 unverified while the suite still showed green.
    await redis.ping();
  });

  afterAll(async () => {
    await redis.quit();
  });

  /** Unique per test, so a re-run never inherits a previous run's counter. */
  const freshKey = () => `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  describe("the Redis counter", () => {
    it("counts upwards across calls", async () => {
      const store = new RedisCounterStore(redis);
      const key = freshKey();

      expect(await store.increment(key, 60)).toBe(1);
      expect(await store.increment(key, 60)).toBe(2);
      expect(await store.increment(key, 60)).toBe(3);
    });

    it("sets an expiry on the window so a counter cannot last forever", async () => {
      const store = new RedisCounterStore(redis);
      const key = freshKey();

      await store.increment(key, 60);

      const ttl = await redis.ttl(`ratelimit:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it("does NOT extend the window on later increments", async () => {
      // A sliding window would let a determined caller hold themselves
      // throttled indefinitely, and would never let a legitimate user recover.
      const store = new RedisCounterStore(redis);
      const key = freshKey();

      await store.increment(key, 60);
      const firstTtl = await redis.ttl(`ratelimit:${key}`);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await store.increment(key, 60);
      const secondTtl = await redis.ttl(`ratelimit:${key}`);

      expect(secondTtl).toBeLessThan(firstTtl);
    });

    it("lets the counter lapse once the window passes", async () => {
      const store = new RedisCounterStore(redis);
      const key = freshKey();

      // A 1-second window, so the expiry is observable rather than assumed.
      expect(await store.increment(key, 1)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await store.increment(key, 1)).toBe(1);
    });

    // ── The two claims B2 is actually about ──────────────────────────────────

    it("SURVIVES a restart — a new process inherits the existing count", async () => {
      // This is B2's first claim. With in-memory limits, restarting the API
      // resets everyone's budget: an attacker just waits for a redeploy.
      const key = freshKey();

      const beforeRestart = new RedisCounterStore(redis);
      await beforeRestart.increment(key, 60);
      await beforeRestart.increment(key, 60);

      // A brand new client + store, exactly as a restarted process would build.
      const newProcess = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
      try {
        const afterRestart = new RedisCounterStore(newProcess);
        // 3, not 1 — the count was not lost.
        expect(await afterRestart.increment(key, 60)).toBe(3);
      } finally {
        await newProcess.quit();
      }
    });

    it("is SHARED between instances — two instances draw on one budget", async () => {
      // B2's second claim. With in-memory limits, a second instance hands the
      // caller a fresh budget, so a load balancer multiplies the limit.
      const key = freshKey();

      const instanceB = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
      try {
        const a = new RedisCounterStore(redis);
        const b = new RedisCounterStore(instanceB);

        expect(await a.increment(key, 60)).toBe(1);
        expect(await b.increment(key, 60)).toBe(2); // not 1
        expect(await a.increment(key, 60)).toBe(3);
      } finally {
        await instanceB.quit();
      }
    });

    it("proves the in-memory store does NOT survive a restart (this is B2 itself)", async () => {
      // The control case. If this ever passed, the Redis tests above would be
      // proving nothing — an in-memory store would look identical.
      const key = freshKey();

      const beforeRestart = new MemoryCounterStore();
      await beforeRestart.increment(key, 60);
      await beforeRestart.increment(key, 60);

      const afterRestart = new MemoryCounterStore();
      expect(await afterRestart.increment(key, 60)).toBe(1); // budget reset — the bug
    });
  });

  describe("provider selection", () => {
    const fakeConfig = (values: Record<string, string | undefined>) =>
      ({ get: (key: string) => values[key] }) as never;

    it("uses Redis when REDIS_URL is set", () => {
      const client = createRedisClient(fakeConfig({ REDIS_URL }));
      expect(client).not.toBeNull();
      try {
        const store = createCounterStore(client);
        expect(store).toBeInstanceOf(RedisCounterStore);
        expect(store.isShared).toBe(true);
      } finally {
        client?.disconnect();
      }
    });

    it("falls back to in-memory when REDIS_URL is unset", () => {
      expect(createRedisClient(fakeConfig({}))).toBeNull();
      const store = createCounterStore(null);
      expect(store).toBeInstanceOf(MemoryCounterStore);
      expect(store.isShared).toBe(false);
    });
  });

  describe("startup guard", () => {
    /** A valid production config minus Redis. See productionEnv() in helpers.ts. */
    const withoutRedis = () => {
      const env = productionEnv();
      delete env.REDIS_URL;
      return env;
    };

    it("refuses to boot in production without Redis", () => {
      expect(() => validateEnv(withoutRedis())).toThrow(/REDIS_URL/);
    });

    it("boots in production with Redis configured", () => {
      expect(() => validateEnv(productionEnv())).not.toThrow();
    });

    it("rejects a malformed REDIS_URL rather than failing at first use", () => {
      expect(() => validateEnv({ ...productionEnv(), REDIS_URL: "localhost:6379" })).toThrow(
        /must start with redis/,
      );
    });

    it("allows in-memory limits outside production", () => {
      expect(() => validateEnv({ ...withoutRedis(), NODE_ENV: "development" })).not.toThrow();
    });
  });

  describe("per-phone OTP limit", () => {
    /**
     * A deliberately small policy, injected rather than read from the
     * environment: these tests must exercise the limit itself, not loop to
     * whatever the production default happens to be. The default's *value* is
     * config; the *behaviour* is what is under test here.
     */
    const POLICY = { limit: 3, windowSeconds: 60 };

    /** A limiter over real Redis, with the small test policy. */
    const limiterOver = (store: CounterStore) => new PhoneRateLimiter(store, POLICY);

    /** Unique per test, so no run inherits another's counter. */
    const testPhone = () =>
      `+96279${Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0")}`;

    it("defaults to a limit that is generous for a real person but useless for abuse", () => {
      // Read with the env override REMOVED. `npm run test:e2e` raises this
      // limit so the suite (which signs in as the same seeded merchant many
      // times) does not throttle itself — but that would make asserting on the
      // live value vacuous: 100000 >= 3 passes while proving nothing. Re-import
      // the module with the override deleted to see the real shipped default.
      jest.isolateModules(() => {
        const original = process.env.RATE_LIMIT_OTP_PER_PHONE_PER_HOUR;
        delete process.env.RATE_LIMIT_OTP_PER_PHONE_PER_HOUR;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { PHONE_OTP_LIMIT: shipped } = require("../src/config/rate-limits");
          expect(shipped.limit).toBe(5);
          expect(shipped.windowSeconds).toBe(3600);
        } finally {
          if (original !== undefined) process.env.RATE_LIMIT_OTP_PER_PHONE_PER_HOUR = original;
        }
      });
    });

    it("allows a real person their full budget", async () => {
      const phone = testPhone();
      const limiter = limiterOver(new RedisCounterStore(redis));

      for (let i = 0; i < POLICY.limit; i++) {
        await expect(limiter.consumeOtpRequest(phone)).resolves.toBeUndefined();
      }
    });

    it("blocks one number being targeted beyond its limit", async () => {
      // The attack the per-IP throttler cannot see: many IPs, one victim's
      // handset, and the founder paying ~$0.04-0.09 for every message.
      const phone = testPhone();
      const limiter = limiterOver(new RedisCounterStore(redis));

      for (let i = 0; i < POLICY.limit; i++) {
        await limiter.consumeOtpRequest(phone);
      }

      await expect(limiter.consumeOtpRequest(phone)).rejects.toThrow(HttpException);
      // Still blocked on the next attempt — not a one-off.
      await expect(limiter.consumeOtpRequest(phone)).rejects.toThrow(/Too many login codes/);
    });

    it("budgets each phone number separately", async () => {
      const victim = testPhone();
      const bystander = testPhone();
      const limiter = limiterOver(new RedisCounterStore(redis));

      for (let i = 0; i < POLICY.limit; i++) {
        await limiter.consumeOtpRequest(victim);
      }
      await expect(limiter.consumeOtpRequest(victim)).rejects.toThrow(HttpException);

      // An unrelated customer must not be locked out by someone else's abuse.
      await expect(limiter.consumeOtpRequest(bystander)).resolves.toBeUndefined();
    });

    it("returns 429, matching the IP throttler's rejection", async () => {
      const phone = testPhone();
      const limiter = limiterOver(new RedisCounterStore(redis));

      for (let i = 0; i < POLICY.limit; i++) {
        await limiter.consumeOtpRequest(phone);
      }

      await expect(limiter.consumeOtpRequest(phone)).rejects.toMatchObject({ status: 429 });
    });

    /**
     * The limiter is actually WIRED INTO the OTP endpoint.
     *
     * Everything above tests PhoneRateLimiter in isolation. None of it notices
     * if `requestOtp` simply never calls it — verified: deleting
     * `consumeOtpRequest` from AuthService left all 345 tests green. B2's
     * headline second half could have been removed and nothing would have said
     * a word.
     *
     * Two things conspire to hide it, which is why it needs its own test:
     *   1. `npm run test:e2e` raises the per-phone limit to 100000 so the suite
     *      does not throttle itself — so it never trips in a normal run.
     *   2. Even unraised, the per-IP limit (3/min) trips long before the
     *      per-phone one (5/hour) on any same-number burst, so no ordinary e2e
     *      can observe the per-phone limit at all.
     *
     * So: throttling off (createTestApp's default), and the limiter overridden
     * with a small policy — the only arrangement in which the per-phone limit
     * is the thing being measured.
     */
    it("IS WIRED INTO the OTP endpoint — not just correct in isolation", async () => {
      const store = new RedisCounterStore(redis);
      const builder = Test.createTestingModule({ imports: [AppModule] });
      builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
      builder
        .overrideProvider(PhoneRateLimiter)
        .useValue(new PhoneRateLimiter(store, { limit: 3, windowSeconds: 60 }));

      const moduleRef = await builder.compile();
      const app = configureApp(moduleRef.createNestApplication());
      await app.init();

      try {
        const http = request(app.getHttpServer());
        const phone = `079${Math.floor(Math.random() * 10_000_000)
          .toString()
          .padStart(7, "0")}`;

        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
          const res = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
          statuses.push(res.status);
        }

        // Three allowed, the fourth refused — by the PHONE limit, since the IP
        // throttler is disabled here.
        expect(statuses).toEqual([200, 200, 200, 429]);
      } finally {
        await app.close();
      }
    });

    it("fails OPEN when Redis is unreachable, rather than locking everyone out", async () => {
      // A judgement call worth pinning: if the limiter cannot reach Redis, the
      // alternatives are "nobody can log in at all" or "the per-phone cap is
      // briefly unenforced while the per-IP throttler still applies". A total
      // login outage is the worse failure.
      const brokenStore: CounterStore = {
        isShared: true,
        increment: () => Promise.reject(new Error("ECONNREFUSED")),
      };

      await expect(
        limiterOver(brokenStore).consumeOtpRequest("+962791234567"),
      ).resolves.toBeUndefined();
    });
  });
});
