import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ShopsService } from "./shops.service";

/**
 * Customer-facing browse endpoints.
 *
 * Requires a signed-in user (the global JwtAuthGuard) but no specific role —
 * customers browse, and merchants/admins may legitimately look at the storefront
 * too. Only APPROVED shops are ever exposed; see ShopsService.
 */
@Controller("shops")
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  /** All shops visible to customers. The pilot has exactly one. */
  @Get()
  findAll() {
    return this.shops.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.shops.findOne(id);
  }

  /** Browse a shop's shelf. `?search=` and `?categoryId=` are optional. */
  @Get(":id/products")
  findProducts(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.shops.findProducts(id, { search, categoryId });
  }

  /** Only the categories this shop actually stocks. */
  @Get(":id/categories")
  findCategories(@Param("id", ParseUUIDPipe) id: string) {
    return this.shops.findCategories(id);
  }
}

@Module({
  controllers: [ShopsController],
  providers: [ShopsService],
})
export class ShopsModule {}
