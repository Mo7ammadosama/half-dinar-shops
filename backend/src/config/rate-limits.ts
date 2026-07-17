/**
 * Rate-limit policy, read from the environment.
 *
 * These are consumed by @Throttle decorators, which are evaluated when their
 * module is first imported — before Nest boots and before ConfigService exists.
 * They therefore read process.env directly, which is why main.ts imports
 * "dotenv/config" before anything else.
 *
 * Defaults are the production-safe values. Overriding them is intended for
 * automated UI test runs, where dozens of registrations come from one IP.
 */
import "dotenv/config";

const ONE_MINUTE_MS = 60_000;

function perMinute(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

export const RATE_LIMITS = {
  /** Baseline for every endpoint. */
  default: { limit: perMinute("RATE_LIMIT_DEFAULT_PER_MIN", 100), ttl: ONE_MINUTE_MS },

  /** Strict: each request can send an SMS to someone else's phone. */
  otpRequest: { limit: perMinute("RATE_LIMIT_OTP_PER_MIN", 3), ttl: ONE_MINUTE_MS },

  /** Guards against guessing a 6-digit code within its lifetime. */
  otpVerify: { limit: perMinute("RATE_LIMIT_OTP_VERIFY_PER_MIN", 10), ttl: ONE_MINUTE_MS },

  /** Stops automated shop-signup floods. */
  register: { limit: perMinute("RATE_LIMIT_REGISTER_PER_MIN", 5), ttl: ONE_MINUTE_MS },
} as const;

/**
 * OTP requests allowed per PHONE NUMBER per hour.
 *
 * Separate from RATE_LIMITS above because the throttler keys on IP, and per-IP
 * limits do not stop one number being targeted from many IPs — the victim's
 * handset gets flooded and the founder pays for every message.
 *
 * 5/hour is deliberately generous for a real person (a mistyped number, a
 * delayed SMS, a retry or two) while making bulk abuse of a single number
 * pointless.
 */
export const PHONE_OTP_LIMIT = {
  limit: perMinute("RATE_LIMIT_OTP_PER_PHONE_PER_HOUR", 5),
  windowSeconds: 3600,
} as const;
