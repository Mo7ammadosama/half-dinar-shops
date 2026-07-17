import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Roles } from "../auth/decorators";
import type { MerchantStatus, OrderStatus } from "../../generated/prisma/enums";
import { AdminService } from "./admin.service";
import { CreateCategoryDto, SetMerchantStatusDto, UpdateCategoryDto } from "./dto";

/**
 * The admin panel's API.
 *
 * ADMIN-only, enforced by the global RolesGuard: a merchant must never be able
 * to approve their own shop, and a customer must never touch any of this.
 */
@Roles("ADMIN")
@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("stats")
  stats() {
    return this.admin.stats();
  }

  // --- Merchants ---------------------------------------------------------

  @Get("merchants")
  findMerchants(@Query("status") status?: MerchantStatus) {
    return this.admin.findMerchants(status);
  }

  /** Approve, reject (= suspend), or put a shop back in the queue. */
  @Patch("merchants/:id/status")
  setMerchantStatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetMerchantStatusDto,
  ) {
    return this.admin.setMerchantStatus(id, dto.status);
  }

  // --- Categories --------------------------------------------------------

  @Get("categories")
  findCategories() {
    return this.admin.findCategories();
  }

  @Post("categories")
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.admin.createCategory(dto);
  }

  @Patch("categories/:id")
  updateCategory(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.admin.updateCategory(id, dto);
  }

  @Delete("categories/:id")
  deleteCategory(@Param("id", ParseUUIDPipe) id: string) {
    return this.admin.deleteCategory(id);
  }

  // --- Orders ------------------------------------------------------------

  @Get("orders")
  findOrders(
    @Query("status") status?: OrderStatus,
    @Query("cancelledOnly") cancelledOnly?: string,
  ) {
    return this.admin.findOrders({ status, cancelledOnly: cancelledOnly === "true" });
  }

  /**
   * Orders a shop has ignored long enough to need the admin.
   *
   * The last step of the escalation chain: new order → shop nudged → still
   * ignored → the admin can see it and phone the shop.
   */
  @Get("orders/ignored")
  findIgnoredOrders() {
    return this.admin.findIgnoredOrders();
  }
}

@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
