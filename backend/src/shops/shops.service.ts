import { Injectable, NotFoundException } from "@nestjs/common";
import { APPROVED_ONLY } from "../common/merchant-visibility";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Customer-facing browsing.
 *
 * THE RULE: customers may only ever see APPROVED shops and their products.
 * Every query here pins APPROVED_ONLY — see common/merchant-visibility.ts.
 */

/** Serializes money as a fixed-2 string; JSON numbers are floats. */
function toApiProduct(product: {
  id: string;
  name: string;
  price: { toFixed: (n: number) => string };
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId: string;
  category?: { id: string; name: string; parentCategory?: { name: string } | null } | null;
}) {
  return {
    id: product.id,
    name: product.name,
    price: product.price.toFixed(2),
    imageUrl: product.imageUrl,
    isAvailable: product.isAvailable,
    categoryId: product.categoryId,
    categoryName: product.category?.name ?? null,
    categoryPath: product.category
      ? product.category.parentCategory
        ? `${product.category.parentCategory.name} > ${product.category.name}`
        : product.category.name
      : null,
  };
}

@Injectable()
export class ShopsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lists shops a customer is allowed to see. The pilot has exactly one. */
  async findAll() {
    const shops = await this.prisma.merchant.findMany({
      where: APPROVED_ONLY,
      select: {
        id: true,
        shopName: true,
        locationLat: true,
        locationLng: true,
        openingHours: true,
        _count: { select: { products: true } },
      },
      orderBy: { shopName: "asc" },
    });

    return shops.map((s) => ({
      id: s.id,
      shopName: s.shopName,
      locationLat: s.locationLat,
      locationLng: s.locationLng,
      openingHours: s.openingHours,
      productCount: s._count.products,
    }));
  }

  /**
   * Resolves one shop by id.
   *
   * `findFirst` with the approved filter — not `findUnique` — so an unapproved
   * shop cannot be confirmed to exist by id.
   */
  async findOne(id: string) {
    const shop = await this.prisma.merchant.findFirst({
      where: { id, ...APPROVED_ONLY },
      select: {
        id: true,
        shopName: true,
        locationLat: true,
        locationLng: true,
        openingHours: true,
        _count: { select: { products: true } },
      },
    });

    if (!shop) throw new NotFoundException("Shop not found.");

    return {
      id: shop.id,
      shopName: shop.shopName,
      locationLat: shop.locationLat,
      locationLng: shop.locationLng,
      openingHours: shop.openingHours,
      productCount: shop._count.products,
    };
  }

  /**
   * Browses a shop's products.
   *
   * Out-of-stock items are returned, not hidden — the customer should see the
   * real shelf, with unavailable items marked. Availability drives ordering so
   * what can actually be bought floats to the top.
   */
  async findProducts(shopId: string, filters: { search?: string; categoryId?: string }) {
    // Resolves the shop first, so browsing an unapproved shop 404s here rather
    // than returning an empty list that looks like an open shop with no stock.
    await this.findOne(shopId);

    const products = await this.prisma.product.findMany({
      where: {
        merchantId: shopId,
        // Belt and braces: the shop is already known-approved, but pinning it
        // here too means this query is safe even if it is reused elsewhere.
        merchant: APPROVED_ONLY,
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.search
          ? { name: { contains: filters.search, mode: "insensitive" as const } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        price: true,
        imageUrl: true,
        isAvailable: true,
        categoryId: true,
        category: { select: { id: true, name: true, parentCategory: { select: { name: true } } } },
      },
      orderBy: [{ isAvailable: "desc" }, { name: "asc" }],
    });

    return products.map(toApiProduct);
  }

  /**
   * Categories that this shop actually stocks.
   *
   * The master category list contains everything every shop might sell; showing
   * a customer a filter that returns nothing would be a dead end.
   */
  async findCategories(shopId: string) {
    await this.findOne(shopId);

    const categories = await this.prisma.category.findMany({
      where: { products: { some: { merchantId: shopId, merchant: APPROVED_ONLY } } },
      select: {
        id: true,
        name: true,
        parentCategory: { select: { name: true } },
        _count: { select: { products: { where: { merchantId: shopId } } } },
      },
    });

    return categories
      .map((c) => ({
        id: c.id,
        name: c.name,
        path: c.parentCategory ? `${c.parentCategory.name} > ${c.name}` : c.name,
        productCount: c._count.products,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}
