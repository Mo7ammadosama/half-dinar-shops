import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RATE_LIMITS } from "../config/rate-limits";
import { PushService } from "../push/push.service";
import { AuthService } from "./auth.service";
import { CurrentUser, Public } from "./decorators";
import { RegisterDeviceDto, RequestOtpDto, UnregisterDeviceDto, VerifyOtpDto } from "./dto";
import type { AuthenticatedUser } from "./jwt-payload";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly push: PushService,
  ) {}

  /**
   * Requests a login code. Public, and tightly rate limited: this endpoint would
   * otherwise let someone spam SMS at a stranger's phone (and run up the bill).
   */
  @Public()
  @Throttle({ default: RATE_LIMITS.otpRequest })
  @Post("otp/request")
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phoneNumber);
  }

  /** Exchanges a valid code for a JWT. Rate limited against code guessing. */
  @Public()
  @Throttle({ default: RATE_LIMITS.otpVerify })
  @Post("otp/verify")
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phoneNumber, dto.code);
  }

  /** Returns the caller's own identity. Requires a valid token. */
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  /**
   * Registers this device for push notifications.
   *
   * Deliberately scoped to the CALLER: the device is always attached to
   * `user.id` from the verified token, never to a userId in the body. Letting
   * the body name the owner would let anyone register their own device against
   * a stranger's account and receive that stranger's order notifications.
   */
  @Post("devices")
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<void> {
    await this.push.registerDevice(user.id, dto.token, dto.platform);
  }

  /** Forgets a device, so a signed-out phone goes quiet. */
  @Delete("devices")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregisterDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnregisterDeviceDto,
  ): Promise<void> {
    // Scoped to the caller's own devices: knowing someone else's token must not
    // be enough to silence their phone.
    await this.push.unregisterOwnDevice(user.id, dto.token);
  }
}
