import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the full category tree.
   *
   * Categories are admin-managed master data shared by all merchants, so this is
   * read-only here — merchants pick from the list but cannot change it. Admin
   * management arrives in Phase 7.
   */
  async findTree() {
    const categories = await this.prisma.category.findMany({
      select: { id: true, name: true, parentCategoryId: true },
      orderBy: { name: "asc" },
    });

    const roots = categories.filter((c) => c.parentCategoryId === null);

    return roots.map((root) => ({
      id: root.id,
      name: root.name,
      subcategories: categories
        .filter((c) => c.parentCategoryId === root.id)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  }

  /** Flat list with display paths — convenient for a dropdown. */
  async findFlat() {
    const categories = await this.prisma.category.findMany({
      select: { id: true, name: true, parentCategory: { select: { name: true } } },
      orderBy: [{ name: "asc" }],
    });

    return categories
      .map((c) => ({
        id: c.id,
        name: c.name,
        path: c.parentCategory ? `${c.parentCategory.name} > ${c.name}` : c.name,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

/**
 * Readable by any authenticated user (merchants need it to categorize products;
 * customers will need it to browse in Phase 3). No write routes exist.
 */
@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  findFlat() {
    return this.categories.findFlat();
  }

  @Get("tree")
  findTree() {
    return this.categories.findTree();
  }
}

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
  // Exported so the AI product-entry endpoint can offer the model the shop's
  // real category list to choose from.
  exports: [CategoriesService],
})
export class CategoriesModule {}
