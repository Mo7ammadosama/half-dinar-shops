import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateProductDto, UpdateProductDto } from "./dto";

/** Shape returned to the dashboard. Decimal is serialized as a fixed-2 string. */
function toApi(product: {
  id: string;
  name: string;
  price: { toFixed: (n: number) => string };
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; parentCategory?: { name: string } | null } | null;
}) {
  return {
    id: product.id,
    name: product.name,
    // Money crosses the wire as a string: JSON numbers are floats, and 0.50
    // must not become 0.5000000001 on the way to a shopkeeper's screen.
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
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

const CATEGORY_INCLUDE = {
  category: { select: { id: true, name: true, parentCategory: { select: { name: true } } } },
} as const;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the caller's shop.
   *
   * `forWrite` additionally blocks suspended shops. Pending shops may still
   * build their catalogue — they simply are not visible to customers until an
   * admin approves them (Phase 7) — otherwise a new merchant could not prepare
   * anything while waiting.
   */
  private async requireOwnMerchant(userId: string, forWrite: boolean) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });

    if (!merchant) throw new NotFoundException("No shop profile found for this account.");
    if (forWrite && merchant.status === "SUSPENDED") {
      throw new ForbiddenException("This shop is suspended and cannot be modified.");
    }
    return merchant;
  }

  /** Confirms a category exists, giving a clear error instead of a raw FK violation. */
  private async requireCategory(categoryId: string) {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new BadRequestException("categoryId does not match any category.");
  }

  /** Lists the caller's own products, optionally filtered. */
  async findAll(userId: string, filters: { search?: string; categoryId?: string }) {
    const merchant = await this.requireOwnMerchant(userId, false);

    const products = await this.prisma.product.findMany({
      where: {
        // Scoped to the caller's shop — a merchant can never list another's stock.
        merchantId: merchant.id,
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.search
          ? { name: { contains: filters.search, mode: "insensitive" as const } }
          : {}),
      },
      include: CATEGORY_INCLUDE,
      orderBy: [{ name: "asc" }],
    });

    return products.map(toApi);
  }

  async findOne(userId: string, id: string) {
    const merchant = await this.requireOwnMerchant(userId, false);

    const product = await this.prisma.product.findFirst({
      where: { id, merchantId: merchant.id },
      include: CATEGORY_INCLUDE,
    });

    // Scoped by merchantId, so another shop's product reads as "not found"
    // rather than "forbidden" — no probing for which ids exist.
    if (!product) throw new NotFoundException("Product not found.");
    return toApi(product);
  }

  async create(userId: string, dto: CreateProductDto) {
    const merchant = await this.requireOwnMerchant(userId, true);
    await this.requireCategory(dto.categoryId);

    const product = await this.prisma.product.create({
      data: {
        merchantId: merchant.id,
        categoryId: dto.categoryId,
        name: dto.name.trim(),
        // Fixed-2 string keeps the Decimal exact; a float could drift.
        price: dto.price.toFixed(2),
        imageUrl: dto.imageUrl ?? null,
        isAvailable: dto.isAvailable ?? true,
      },
      include: CATEGORY_INCLUDE,
    });

    return toApi(product);
  }

  async update(userId: string, id: string, dto: UpdateProductDto) {
    const merchant = await this.requireOwnMerchant(userId, true);
    if (dto.categoryId) await this.requireCategory(dto.categoryId);

    // Confirm ownership before writing; updateMany-style scoping would silently
    // succeed with 0 rows for someone else's product.
    const existing = await this.prisma.product.findFirst({
      where: { id, merchantId: merchant.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Product not found.");

    const product = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.price !== undefined ? { price: dto.price.toFixed(2) } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}),
        ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
      },
      include: CATEGORY_INCLUDE,
    });

    return toApi(product);
  }

  async setAvailability(userId: string, id: string, isAvailable: boolean) {
    return this.update(userId, id, { isAvailable });
  }

  async remove(userId: string, id: string) {
    const merchant = await this.requireOwnMerchant(userId, true);

    const existing = await this.prisma.product.findFirst({
      where: { id, merchantId: merchant.id },
      select: { id: true, _count: { select: { orderItems: true } } },
    });
    if (!existing) throw new NotFoundException("Product not found.");

    // The schema restricts this delete to protect order history. Check first so
    // the merchant gets an explanation instead of a database error.
    if (existing._count.orderItems > 0) {
      throw new ConflictException(
        "This product appears in past orders and cannot be deleted. Mark it unavailable instead.",
      );
    }

    await this.prisma.product.delete({ where: { id } });
    return { deleted: true, id };
  }
}
