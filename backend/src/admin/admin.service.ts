import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import type { MerchantStatus, OrderStatus } from "../../generated/prisma/enums";
import { escalationLevel } from "../orders/escalation-policy";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateCategoryDto, UpdateCategoryDto } from "./dto";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Merchants ---------------------------------------------------------

  /** Every shop, whatever its status — this is the approval queue. */
  async findMerchants(status?: MerchantStatus) {
    const merchants = await this.prisma.merchant.findMany({
      where: status ? { status } : {},
      select: {
        id: true,
        shopName: true,
        status: true,
        locationLat: true,
        locationLng: true,
        openingHours: true,
        commissionRate: true,
        user: { select: { phoneNumber: true, createdAt: true } },
        _count: { select: { products: true, orders: true } },
      },
      orderBy: [{ status: "asc" }, { shopName: "asc" }],
    });

    return merchants.map((m) => ({
      id: m.id,
      shopName: m.shopName,
      status: m.status,
      phoneNumber: m.user.phoneNumber,
      locationLat: m.locationLat,
      locationLng: m.locationLng,
      openingHours: m.openingHours,
      commissionRate: m.commissionRate.toString(),
      productCount: m._count.products,
      orderCount: m._count.orders,
      registeredAt: m.user.createdAt,
    }));
  }

  /**
   * Sets a shop's status.
   *
   * This is the switch that makes a shop visible to customers at all — every
   * customer-facing query filters on APPROVED (see common/merchant-visibility).
   */
  async setMerchantStatus(merchantId: string, status: MerchantStatus) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, status: true },
    });
    if (!merchant) throw new NotFoundException("Shop not found.");

    if (merchant.status === status) {
      throw new ConflictException(`This shop is already ${status.toLowerCase()}.`);
    }

    await this.prisma.merchant.update({ where: { id: merchantId }, data: { status } });
    return this.findMerchants().then((all) => all.find((m) => m.id === merchantId)!);
  }

  // --- Categories (admin-managed master data) -----------------------------

  async findCategories() {
    const categories = await this.prisma.category.findMany({
      select: {
        id: true,
        name: true,
        parentCategoryId: true,
        parentCategory: { select: { name: true } },
        _count: { select: { products: true, subcategories: true } },
      },
      orderBy: { name: "asc" },
    });

    return categories
      .map((c) => ({
        id: c.id,
        name: c.name,
        parentCategoryId: c.parentCategoryId,
        path: c.parentCategory ? `${c.parentCategory.name} > ${c.name}` : c.name,
        productCount: c._count.products,
        subcategoryCount: c._count.subcategories,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async createCategory(dto: CreateCategoryDto) {
    if (dto.parentCategoryId) {
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentCategoryId },
        select: { id: true, parentCategoryId: true },
      });
      if (!parent) throw new BadRequestException("parentCategoryId does not match any category.");
      // Two levels is what the app renders; deeper trees would not display.
      if (parent.parentCategoryId) {
        throw new BadRequestException("Categories can only be nested one level deep.");
      }
    }

    const name = dto.name.trim();

    // PostgreSQL treats NULLs as distinct in unique indexes, so the composite
    // (parent_category_id, name) constraint does NOT stop two root categories
    // sharing a name. Checked explicitly here — see CLAUDE.md.
    const clash = await this.prisma.category.findFirst({
      where: { name, parentCategoryId: dto.parentCategoryId ?? null },
      select: { id: true },
    });
    if (clash) throw new ConflictException("A category with that name already exists here.");

    const created = await this.prisma.category.create({
      data: { name, parentCategoryId: dto.parentCategoryId ?? null },
      select: { id: true },
    });

    return this.findCategories().then((all) => all.find((c) => c.id === created.id)!);
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true, parentCategoryId: true },
    });
    if (!category) throw new NotFoundException("Category not found.");

    const name = dto.name.trim();

    const clash = await this.prisma.category.findFirst({
      where: { name, parentCategoryId: category.parentCategoryId, id: { not: id } },
      select: { id: true },
    });
    if (clash) throw new ConflictException("A category with that name already exists here.");

    await this.prisma.category.update({ where: { id }, data: { name } });
    return this.findCategories().then((all) => all.find((c) => c.id === id)!);
  }

  /**
   * Deletes a category.
   *
   * Refused while anything depends on it. The database would block it anyway
   * (onDelete: Restrict), but a clear explanation beats a raw constraint error.
   */
  async deleteCategory(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: { products: true, subcategories: true } } },
    });
    if (!category) throw new NotFoundException("Category not found.");

    if (category._count.products > 0) {
      throw new ConflictException(
        `"${category.name}" still has ${category._count.products} product(s) in it.`,
      );
    }
    if (category._count.subcategories > 0) {
      throw new ConflictException(
        `"${category.name}" still has ${category._count.subcategories} subcategory(ies).`,
      );
    }

    await this.prisma.category.delete({ where: { id } });
    return { deleted: true, id };
  }

  // --- Orders -------------------------------------------------------------

  /** Every order across every shop, for oversight and escalations. */
  async findOrders(filters: { status?: OrderStatus; cancelledOnly?: boolean }) {
    const orders = await this.prisma.order.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.cancelledOnly ? { status: "CANCELLED" } : {}),
      },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        cancelledBy: true,
        cancellationReason: true,
        createdAt: true,
        customer: { select: { phoneNumber: true } },
        merchant: { select: { shopName: true } },
        delivery: { select: { captainName: true, status: true } },
        review: { select: { rating: true, comment: true } },
        _count: { select: { orderItems: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return orders.map((o) => ({
      id: o.id,
      status: o.status,
      shopName: o.merchant.shopName,
      customerPhone: o.customer.phoneNumber,
      totalPrice: o.totalPrice.toFixed(2),
      itemCount: o._count.orderItems,
      cancelledBy: o.cancelledBy,
      cancellationReason: o.cancellationReason,
      delivery: o.delivery,
      review: o.review,
      createdAt: o.createdAt,
    }));
  }

  /**
   * Orders a shop has not responded to — the admin's escalation queue.
   *
   * Derived entirely from order data (status + age), never from a stored flag
   * or an in-memory timer. That matters: a timer-based escalation is wiped by
   * every restart, silently forgiving exactly the orders that most need
   * chasing. Computed this way, the list is correct after any redeploy.
   */
  async findIgnoredOrders() {
    const pending = await this.prisma.order.findMany({
      where: { status: "PENDING" },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        createdAt: true,
        customer: { select: { phoneNumber: true } },
        merchant: { select: { id: true, shopName: true, user: { select: { phoneNumber: true } } } },
        _count: { select: { orderItems: true } },
      },
      orderBy: { createdAt: "asc" }, // longest-waiting first — the worst case leads
    });

    const now = new Date();

    return pending
      .map((o) => ({
        id: o.id,
        status: o.status,
        shopName: o.merchant.shopName,
        // The admin's job here is to phone the shop, so they need its number.
        shopPhone: o.merchant.user.phoneNumber,
        customerPhone: o.customer.phoneNumber,
        totalPrice: o.totalPrice.toFixed(2),
        itemCount: o._count.orderItems,
        createdAt: o.createdAt,
        waitingSeconds: Math.floor((now.getTime() - o.createdAt.getTime()) / 1000),
        escalationLevel: escalationLevel(o.status, o.createdAt, now),
      }))
      // Only what the admin needs to act on. A pending order two minutes old is
      // a shop doing its job, not an incident.
      .filter((o) => o.escalationLevel === 2);
  }

  /** Headline numbers for the admin's landing view. */
  async stats() {
    const [pendingMerchants, approvedMerchants, totalOrders, cancelled, delivered, reviews] =
      await Promise.all([
        this.prisma.merchant.count({ where: { status: "PENDING" } }),
        this.prisma.merchant.count({ where: { status: "APPROVED" } }),
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: "CANCELLED" } }),
        this.prisma.order.count({ where: { status: "DELIVERED" } }),
        this.prisma.review.aggregate({ _avg: { rating: true }, _count: true }),
      ]);

    return {
      pendingMerchants,
      approvedMerchants,
      totalOrders,
      cancelledOrders: cancelled,
      deliveredOrders: delivered,
      reviewCount: reviews._count,
      averageRating: reviews._avg.rating
        ? new Prisma.Decimal(reviews._avg.rating).toFixed(1)
        : null,
    };
  }
}
