/**
 * Rate limiting e2e test.
 *
 * Boots the app with the real ThrottlerGuard in place (unlike api.e2e-spec.ts,
 * which disables it). Kept in its own file because the limit is per-IP: any
 * other test sharing this app instance would consume the same budget.
 */
import { INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import request from "supertest";
import { RATE_LIMITS } from "../src/config/rate-limits";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, uniquePhone } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
const phoneNumber = uniquePhone();

/**
 * Clears rate-limit counters left by a previous run.
 *
 * Needed since Phase 8 made rate limiting persistent (blocker B2). This test
 * asserts "the first N requests succeed", which assumed a fresh in-memory
 * counter on every run — now that counters genuinely survive restarts, a second
 * run inside the same minute starts already throttled and fails. That is the
 * fix working, not breaking: the test simply has to control its own starting
 * state now.
 *
 * Flushing is safe here: this Redis is dedicated to the project and holds only
 * ephemeral rate-limit counters (docker-compose runs it with persistence off).
 * It is keyed by IP, so there is no per-test key to delete selectively.
 */
async function resetRateLimitCounters() {
  const url = process.env.REDIS_URL;
  if (!url) return; // in-memory: a fresh app instance already starts clean

  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

beforeAll(async () => {
  await resetRateLimitCounters();
  ({ app, prisma } = await createTestApp(true)); // throttling ON
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phoneNumber } });
  await app.close();
});

describe("Rate limiting", () => {
  it("throttles repeated OTP requests so SMS cannot be weaponized", async () => {
    const { limit } = RATE_LIMITS.otpRequest;
    const statuses: number[] = [];

    // Two past the limit, to prove it keeps rejecting.
    for (let i = 0; i < limit + 2; i++) {
      const res = await request(app.getHttpServer())
        .post("/api/auth/otp/request")
        .send({ phoneNumber });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, limit)).toEqual(Array(limit).fill(200));
    expect(statuses.slice(limit)).toEqual([429, 429]);
  });

  it("does not apply the strict OTP limit to ordinary endpoints", async () => {
    // A regression guard: declaring a second named throttler globally would cap
    // every route at 3 requests/minute and break the dashboard.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer()).get("/api/products");
      statuses.push(res.status);
    }

    // Unauthenticated, so 401 — the point is that none are 429.
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});
