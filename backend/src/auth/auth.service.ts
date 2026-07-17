import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomInt } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { PhoneRateLimiter } from "../rate-limit/phone-rate-limiter";
import { SMS_SENDER, SmsSendError, type SmsSender } from "../sms/sms.types";
import type { JwtPayload } from "./jwt-payload";

export interface OtpRequestResult {
  /** Seconds until the code expires. */
  expiresInSeconds: number;
  /** Populated only when EXPOSE_OTP_IN_RESPONSE is enabled (development). */
  devCode?: string;
}

export interface LoginResult {
  accessToken: string;
  user: { id: string; phoneNumber: string; role: string; merchantId?: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    private readonly phoneLimiter: PhoneRateLimiter,
  ) {}

  /**
   * Issues a one-time passcode for a phone number.
   *
   * The user row is created on first contact, so requesting a code doubles as
   * customer sign-up. Merchants must additionally register a shop profile.
   *
   * Note this always succeeds for any validly-formatted number, whether or not
   * an account exists — otherwise the endpoint would let anyone enumerate which
   * phone numbers are registered.
   */
  async requestOtp(phoneNumber: string): Promise<OtpRequestResult> {
    // Checked BEFORE any work: this limit exists to stop a stranger's handset
    // being flooded (and the SMS bill being run up) from many IPs, so it must
    // gate the send rather than merely report on it afterwards.
    //
    // Keyed on the normalized number, so "0791234567" and "+962791234567"
    // cannot each get their own budget.
    await this.phoneLimiter.consumeOtpRequest(phoneNumber);

    const user = await this.prisma.user.upsert({
      where: { phoneNumber },
      update: {},
      create: { phoneNumber },
      select: { id: true },
    });

    const ttlSeconds = this.config.getOrThrow<number>("OTP_TTL_SECONDS");

    // randomInt is cryptographically secure, unlike Math.random.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = await argon2.hash(code);

    // Invalidate any outstanding codes so only the newest one works.
    await this.prisma.otpCode.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });

    // Hand off to whichever sender is configured. The dev sender prints it; a
    // real provider actually delivers it. See src/sms/.
    try {
      await this.sms.send({
        to: phoneNumber,
        body: this.otpMessageBody(code, ttlSeconds),
      });
    } catch (error) {
      if (error instanceof SmsSendError) {
        // The gateway did not take the message, so no code is coming. Say so
        // rather than leaving the customer staring at a code entry box.
        //
        // The detail is logged, not returned: provider errors can name the
        // account/sender, and this endpoint is public.
        this.logger.error(`SMS send failed via ${error.provider}: ${error.message}`);
        throw new ServiceUnavailableException(
          "We could not send your code right now. Please try again in a moment.",
        );
      }
      throw error;
    }

    const expose = this.config.get<boolean>("EXPOSE_OTP_IN_RESPONSE") === true;

    return { expiresInSeconds: ttlSeconds, ...(expose ? { devCode: code } : {}) };
  }

  /**
   * The SMS body.
   *
   * Kept short and single-purpose on purpose: Jordan classes anything
   * promotional differently (an "adv" sender prefix and a 9pm curfew), so a
   * transactional login code must not carry marketing text.
   */
  private otpMessageBody(code: string, ttlSeconds: number): string {
    const minutes = Math.max(1, Math.round(ttlSeconds / 60));
    return `${code} is your Half-Dinar Shops login code. It expires in ${minutes} minute${
      minutes === 1 ? "" : "s"
    }. Do not share it with anyone.`;
  }

  /**
   * Verifies a passcode and issues a JWT.
   *
   * Every failure path returns the same generic message so the endpoint cannot
   * be used to distinguish "no such account" from "wrong code".
   */
  async verifyOtp(phoneNumber: string, code: string): Promise<LoginResult> {
    const invalid = () => new UnauthorizedException("Invalid or expired code");

    const user = await this.prisma.user.findUnique({
      where: { phoneNumber },
      select: { id: true, phoneNumber: true, role: true, merchant: { select: { id: true } } },
    });
    if (!user) throw invalid();

    const otp = await this.prisma.otpCode.findFirst({
      where: { userId: user.id, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) throw invalid();

    if (otp.expiresAt.getTime() < Date.now()) throw invalid();

    const maxAttempts = this.config.getOrThrow<number>("OTP_MAX_ATTEMPTS");
    if (otp.attempts >= maxAttempts) throw invalid();

    const matches = await argon2.verify(otp.codeHash, code);
    if (!matches) {
      // Count the failure so a code cannot be brute-forced within its lifetime.
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalid();
    }

    // Single-use: burn the code and mark the phone number verified.
    const [, verifiedUser] = await this.prisma.$transaction([
      this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { otpVerified: true },
        select: { id: true, phoneNumber: true, role: true, merchant: { select: { id: true } } },
      }),
    ]);

    const payload: JwtPayload = { sub: verifiedUser.id, role: verifiedUser.role };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: verifiedUser.id,
        phoneNumber: verifiedUser.phoneNumber,
        role: verifiedUser.role,
        ...(verifiedUser.merchant ? { merchantId: verifiedUser.merchant.id } : {}),
      },
    };
  }
}
