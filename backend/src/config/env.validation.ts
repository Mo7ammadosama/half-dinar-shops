/**
 * Environment variable validation, run at startup.
 *
 * The app refuses to boot on bad config rather than failing later in a way that
 * is harder to diagnose — and, in the case of a weak JWT secret, harder to
 * notice at all.
 */

/** Minimum entropy we accept for the token-signing secret. */
const MIN_JWT_SECRET_LENGTH = 32;

/** Placeholder values that must never reach a deployed environment. */
const FORBIDDEN_SECRETS = ["changeme", "secret", "dev", "test", "password"];

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  OTP_TTL_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  UPLOAD_DIR: string;
  MAX_UPLOAD_BYTES: number;
  /** Flat delivery fee in JOD, as a fixed-2 string (money is never a float). */
  DELIVERY_FEE_JOD: string;
  /**
   * When true, the OTP request endpoint returns the code in its response so the
   * flow is testable without an SMS provider. Never enable in production.
   */
  EXPOSE_OTP_IN_RESPONSE: boolean;
  /** "console" (dev, prints the code) or "twilio". Auto-detected when unset. */
  SMS_PROVIDER?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_SMS_FROM?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  SMS_TIMEOUT_MS: number;
  /** "local" (dev, disk) or "s3". Auto-detected when unset. */
  STORAGE_PROVIDER?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_BASE_URL?: string;
  S3_KEY_PREFIX?: string;
  /** Redis connection for rate limiting. Required in production (blocker B2). */
  REDIS_URL?: string;
}

/**
 * Mirrors the auto-detection in src/storage/storage.module.ts, for the same
 * reason as resolveSmsProvider: this runs before the module graph exists.
 */
function resolveStorageProvider(env: Record<string, unknown>): string {
  const explicit = String(env.STORAGE_PROVIDER ?? "").trim().toLowerCase();
  if (explicit) return explicit;

  const hasCredentials =
    Boolean(String(env.S3_BUCKET ?? "").trim()) &&
    Boolean(String(env.S3_ACCESS_KEY_ID ?? "").trim()) &&
    Boolean(String(env.S3_SECRET_ACCESS_KEY ?? "").trim()) &&
    Boolean(String(env.S3_PUBLIC_BASE_URL ?? "").trim());

  return hasCredentials ? "s3" : "local";
}

/**
 * Mirrors the auto-detection in src/sms/sms.module.ts.
 *
 * Duplicated here on purpose: this runs at boot, before the module graph is
 * built, and its whole job is to refuse to start rather than discover the
 * problem on a customer's first login attempt. The two must agree — the test
 * "refuses to boot in production without a real SMS provider" pins that.
 */
function resolveSmsProvider(env: Record<string, unknown>): string {
  const explicit = String(env.SMS_PROVIDER ?? "").trim().toLowerCase();
  if (explicit) return explicit;

  const hasCredentials =
    Boolean(String(env.TWILIO_ACCOUNT_SID ?? "").trim()) &&
    Boolean(String(env.TWILIO_AUTH_TOKEN ?? "").trim()) &&
    (Boolean(String(env.TWILIO_SMS_FROM ?? "").trim()) ||
      Boolean(String(env.TWILIO_MESSAGING_SERVICE_SID ?? "").trim()));

  return hasCredentials ? "twilio" : "console";
}

function requireString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Environment variable ${key} is required but missing or empty.`);
  }
  return value;
}

function intOrDefault(env: Record<string, unknown>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer, got "${String(raw)}".`);
  }
  return parsed;
}

export function validateEnv(env: Record<string, unknown>): AppEnv {
  const nodeEnv = (env.NODE_ENV as string) ?? "development";
  const isProduction = nodeEnv === "production";

  const jwtSecret = requireString(env, "JWT_SECRET");
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }
  if (FORBIDDEN_SECRETS.some((weak) => jwtSecret.toLowerCase().includes(weak))) {
    throw new Error("JWT_SECRET looks like a placeholder. Use a random, unguessable value.");
  }

  const exposeOtp = String(env.EXPOSE_OTP_IN_RESPONSE ?? "false") === "true";
  if (isProduction && exposeOtp) {
    // Returning the OTP to the caller would make phone login meaningless.
    throw new Error("EXPOSE_OTP_IN_RESPONSE must not be enabled when NODE_ENV=production.");
  }

  const smsProvider = resolveSmsProvider(env);
  if (!["console", "twilio"].includes(smsProvider)) {
    throw new Error(`Unknown SMS_PROVIDER "${smsProvider}". Supported: "console", "twilio".`);
  }
  if (isProduction && smsProvider === "console") {
    // Without this, a production deploy missing its Twilio keys would boot
    // happily and simply never deliver a login code — nobody could sign in, and
    // the logs would look normal. Fail at boot instead. This is blocker B3's
    // guard: the console sender cannot become the production path by omission.
    throw new Error(
      "No real SMS provider is configured, so nobody could receive a login code. " +
        "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM " +
        "(or TWILIO_MESSAGING_SERVICE_SID). See docs/SMS_SETUP.md.",
    );
  }

  const storageProvider = resolveStorageProvider(env);
  if (!["local", "s3"].includes(storageProvider)) {
    throw new Error(`Unknown STORAGE_PROVIDER "${storageProvider}". Supported: "local", "s3".`);
  }
  if (isProduction && storageProvider === "local") {
    // Blocker B1's guard. Local disk in production means every product photo
    // the merchant uploads is destroyed by the next redeploy — silently, with
    // no error anywhere. Refuse to start instead of losing their work.
    throw new Error(
      "Product photos would be stored on local disk, which is destroyed on redeploy. " +
        "Configure object storage: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, " +
        "S3_PUBLIC_BASE_URL (+ S3_ENDPOINT for Cloudflare R2). See docs/STORAGE_SETUP.md.",
    );
  }

  const redisUrl = String(env.REDIS_URL ?? "").trim() || undefined;
  if (isProduction && !redisUrl) {
    // Blocker B2's guard. In-memory rate limits reset on every restart and are
    // not shared between instances, so OTP/SMS abuse protection could be
    // bypassed by waiting for a redeploy or hitting a second instance — while
    // the founder pays for every message sent.
    throw new Error(
      "REDIS_URL is required in production: rate limits would otherwise be in-memory, " +
        "resetting on restart and not shared between instances. See docs/REDIS_SETUP.md.",
    );
  }
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) {
    throw new Error(`REDIS_URL must start with redis:// or rediss://, got "${redisUrl}".`);
  }

  // Money must be an exact fixed-2 value. A malformed fee would silently
  // corrupt every order total, so it is validated at boot rather than trusted.
  const deliveryFee = (env.DELIVERY_FEE_JOD as string) || "0.50";
  if (!/^\d+\.\d{2}$/.test(deliveryFee)) {
    throw new Error(
      `DELIVERY_FEE_JOD must be an amount with exactly 2 decimal places (e.g. "0.50"), got "${deliveryFee}".`,
    );
  }

  return {
    NODE_ENV: nodeEnv,
    PORT: intOrDefault(env, "PORT", 3000),
    DELIVERY_FEE_JOD: deliveryFee,
    DATABASE_URL: requireString(env, "DATABASE_URL"),
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: (env.JWT_EXPIRES_IN as string) || "7d",
    OTP_TTL_SECONDS: intOrDefault(env, "OTP_TTL_SECONDS", 300),
    OTP_MAX_ATTEMPTS: intOrDefault(env, "OTP_MAX_ATTEMPTS", 5),
    UPLOAD_DIR: (env.UPLOAD_DIR as string) || "uploads",
    MAX_UPLOAD_BYTES: intOrDefault(env, "MAX_UPLOAD_BYTES", 5 * 1024 * 1024),
    EXPOSE_OTP_IN_RESPONSE: exposeOtp,
    SMS_PROVIDER: smsProvider,
    TWILIO_ACCOUNT_SID: (env.TWILIO_ACCOUNT_SID as string) || undefined,
    TWILIO_AUTH_TOKEN: (env.TWILIO_AUTH_TOKEN as string) || undefined,
    TWILIO_SMS_FROM: (env.TWILIO_SMS_FROM as string) || undefined,
    TWILIO_MESSAGING_SERVICE_SID: (env.TWILIO_MESSAGING_SERVICE_SID as string) || undefined,
    SMS_TIMEOUT_MS: intOrDefault(env, "SMS_TIMEOUT_MS", 10_000),
    STORAGE_PROVIDER: storageProvider,
    S3_BUCKET: (env.S3_BUCKET as string) || undefined,
    S3_REGION: (env.S3_REGION as string) || undefined,
    S3_ACCESS_KEY_ID: (env.S3_ACCESS_KEY_ID as string) || undefined,
    S3_SECRET_ACCESS_KEY: (env.S3_SECRET_ACCESS_KEY as string) || undefined,
    S3_ENDPOINT: (env.S3_ENDPOINT as string) || undefined,
    S3_PUBLIC_BASE_URL: (env.S3_PUBLIC_BASE_URL as string) || undefined,
    S3_KEY_PREFIX: (env.S3_KEY_PREFIX as string) || undefined,
    REDIS_URL: redisUrl,
  };
}
