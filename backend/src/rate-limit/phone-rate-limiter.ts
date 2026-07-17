import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { COUNTER_STORE, type CounterStore } from "./counter-store";
import { PHONE_OTP_LIMIT } from "../config/rate-limits";

/**
 * Per-phone-number OTP limiting.
 *
 * The IP throttler protects the *server*; this protects a *person* and the
 * founder's SMS bill. Without it, one phone number can be targeted from many
 * IPs — every request inside its own per-IP budget — and the victim's handset
 * is flooded while the founder pays roughly $0.04–0.09 per message.
 *
 * This is the second half of blocker B2, and the reason it is called out
 * separately in the blocker table.
 */
export interface PhoneOtpPolicy {
  limit: number;
  windowSeconds: number;
}

@Injectable()
export class PhoneRateLimiter {
  private readonly logger = new Logger(PhoneRateLimiter.name);

  constructor(
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
    /**
     * Constructor-injectable so tests can pin a small, fast limit instead of
     * looping to the production default.
     *
     * @Optional() is required: without it Nest tries to resolve PhoneOtpPolicy
     * as a provider (it is a plain interface with no token) and fails to build
     * the module. Marked optional, Nest passes undefined and the TypeScript
     * default below applies.
     */
    @Optional() private readonly policy: PhoneOtpPolicy = PHONE_OTP_LIMIT,
  ) {}

  /**
   * Records one OTP request for a number, rejecting it when over the limit.
   *
   * Deliberately keyed on the **normalized E.164 number**, so "0791234567" and
   * "+962791234567" share one budget rather than getting one each.
   */
  async consumeOtpRequest(phoneNumber: string): Promise<void> {
    const { limit, windowSeconds } = this.policy;

    let count: number;
    try {
      count = await this.counters.increment(`otp:phone:${phoneNumber}`, windowSeconds);
    } catch (error) {
      // Fail OPEN, deliberately.
      //
      // If Redis is unreachable, the choice is "nobody in the country can log
      // in" versus "the per-phone cap is briefly unenforced while the per-IP
      // throttler still applies". A total login outage is the worse failure,
      // and the IP limit plus OTP_MAX_ATTEMPTS still stand. Logged as an error
      // because it must not pass unnoticed.
      this.logger.error(
        `Phone rate limiter unavailable, allowing the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (count > limit) {
      this.logger.warn(`OTP request limit reached for ${phoneNumber} (${count}/${limit})`);
      // 429 with the same shape as the IP throttler's rejection.
      throw new HttpException(
        "Too many login codes requested for this number. Please try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
