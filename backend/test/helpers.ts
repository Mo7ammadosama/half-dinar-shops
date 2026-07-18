import { INestApplication } from "@nestjs/common";
import { Test, TestingModuleBuilder } from "@nestjs/testing";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { PrismaService } from "../src/prisma/prisma.service";
import { MockVisionAnalyzer } from "../src/vision/mock-vision.analyzer";
import { VISION_ANALYZER } from "../src/vision/vision.types";

/**
 * Boots the real application for e2e tests.
 *
 * `withThrottling: false` (the default) replaces the global rate-limit guard so
 * a test suite firing dozens of requests from one IP is not throttled. Rate
 * limiting itself is covered separately by throttle.e2e-spec.ts, which boots the
 * app with the guard intact.
 *
 * `configure` gives a suite a hook onto the module builder to override a
 * provider for that suite alone — e.g. to pin the mock vision analyzer so the
 * endpoint's contract is tested deterministically no matter what real API keys
 * happen to sit in the developer's .env (a live ANTHROPIC_API_KEY otherwise
 * flips the seam to the real Claude analyzer and the endpoint tests hit the
 * network — see forceMockVision below).
 */
export async function createTestApp(
  withThrottling = false,
  configure?: (builder: TestingModuleBuilder) => void,
): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (!withThrottling) {
    // overrideProvider (not overrideGuard): AppModule registers ThrottlerGuard
    // as a plain provider and binds APP_GUARD to it with useExisting, so the
    // provider token is what has to be replaced.
    builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
  }

  configure?.(builder);

  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

/**
 * Pins the AI product-entry seam to the deterministic mock analyzer.
 *
 * Pass to createTestApp's `configure` hook. Without it, a real ANTHROPIC_API_KEY
 * in .env makes the endpoint call live Claude — non-deterministic, network-bound,
 * and (offline or on a refusal) a 503 that fails the contract tests for a reason
 * that has nothing to do with the endpoint. The live path is deliberately not
 * covered here; the analyzer unit tests mock the SDK instead.
 */
export function forceMockVision(builder: TestingModuleBuilder): void {
  builder.overrideProvider(VISION_ANALYZER).useValue(new MockVisionAnalyzer());
}

/**
 * A complete, valid PRODUCTION configuration.
 *
 * Every startup guard (SMS/B3, storage/B1, Redis/B2) refuses to boot production
 * when its own dependency is missing. So a test asserting "production boots once
 * X is configured" must satisfy *all* the other guards too, or it fails for a
 * reason that has nothing to do with X.
 *
 * Defined once, here, deliberately: when this was duplicated per spec file,
 * adding the Redis guard silently broke the SMS and storage specs — each new
 * guard invalidated every other file's hand-rolled baseline. Tests override the
 * one key they are actually about:
 *
 *     validateEnv({ ...productionEnv(), REDIS_URL: undefined })  // expect throw
 *
 * ADDING A NEW PRODUCTION GUARD? Add its satisfying value here.
 */
export function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@localhost:5433/db",
    JWT_SECRET: "x".repeat(48),
    // B3 — a real SMS provider must exist.
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "token",
    TWILIO_SMS_FROM: "HalfDinar",
    // B1 — photos must not be on ephemeral disk.
    S3_BUCKET: "photos",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_PUBLIC_BASE_URL: "https://cdn.example.com",
    // B2 — rate limits must be shared and persistent.
    REDIS_URL: "redis://cache:6379",
  };
}

/** Random Jordanian mobile number, so parallel/repeat runs never collide. */
export function uniquePhone(): string {
  const digits = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `+96279${digits}`;
}

/** A valid 2x2 PNG, used to test the upload path. */
export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC",
  "base64",
);
