import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser, JwtPayload } from "./jwt-payload";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_SECRET"),
    });
  }

  /**
   * Re-reads the user from the database on every request rather than trusting
   * the token's claims. A token issued before a role change or account deletion
   * must not keep working, so the database stays the source of truth.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        phoneNumber: true,
        role: true,
        otpVerified: true,
        merchant: { select: { id: true } },
      },
    });

    if (!user) throw new UnauthorizedException("Account no longer exists");
    if (!user.otpVerified) throw new UnauthorizedException("Phone number is not verified");

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      role: user.role,
      merchantId: user.merchant?.id,
    };
  }
}
