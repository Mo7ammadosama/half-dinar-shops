import { Body, Controller, Get, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser, Public, Roles } from "../auth/decorators";
import { RATE_LIMITS } from "../config/rate-limits";
import type { AuthenticatedUser } from "../auth/jwt-payload";
import { RegisterMerchantDto } from "./dto";
import { MerchantsService } from "./merchants.service";

@Controller("merchants")
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  /** Public shop registration. Rate limited to stop automated signup floods. */
  @Public()
  @Throttle({ default: RATE_LIMITS.register })
  @Post("register")
  register(@Body() dto: RegisterMerchantDto) {
    return this.merchants.register(dto);
  }

  /** The calling merchant's own profile. */
  @Roles("MERCHANT")
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.findOwnProfile(user.id);
  }
}
