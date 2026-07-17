import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { RegisterMerchantDto } from "./dto";

@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers a new shop. The merchant is created with status PENDING and must
   * be approved by an admin (Phase 7) before customers can see it.
   *
   * Registering does not log anyone in — the owner still has to prove they hold
   * the phone number via OTP. That keeps this public endpoint from being a way
   * to seize an account by registering someone else's number.
   */
  async register(dto: RegisterMerchantDto) {
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
      select: { id: true, role: true, merchant: { select: { id: true } } },
    });

    if (existing?.merchant) {
      throw new ConflictException("A shop is already registered to this phone number.");
    }
    if (existing && existing.role === "ADMIN") {
      throw new ConflictException("This phone number cannot be used to register a shop.");
    }

    // Everything below must succeed or fail together — a user promoted to
    // MERCHANT without a shop profile would be a broken account.
    const merchant = await this.prisma.$transaction(async (tx) => {
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { role: "MERCHANT" },
            select: { id: true },
          })
        : await tx.user.create({
            data: { phoneNumber: dto.phoneNumber, role: "MERCHANT" },
            select: { id: true },
          });

      return tx.merchant.create({
        data: {
          userId: user.id,
          shopName: dto.shopName,
          locationLat: dto.locationLat,
          locationLng: dto.locationLng,
          openingHours: dto.openingHours,
          status: "PENDING",
        },
        select: {
          id: true,
          shopName: true,
          status: true,
          locationLat: true,
          locationLng: true,
          openingHours: true,
        },
      });
    });

    return {
      merchant,
      message:
        "Shop registered and awaiting admin approval. Request a login code to sign in and start adding products.",
    };
  }

  /** Returns the calling merchant's own shop profile. */
  async findOwnProfile(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { userId },
      select: {
        id: true,
        shopName: true,
        status: true,
        locationLat: true,
        locationLng: true,
        openingHours: true,
        commissionRate: true,
        _count: { select: { products: true } },
      },
    });

    if (!merchant) throw new NotFoundException("No shop profile found for this account.");

    return {
      ...merchant,
      commissionRate: merchant.commissionRate.toString(),
      productCount: merchant._count.products,
      _count: undefined,
    };
  }
}
