import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Sse } from "@nestjs/common";
import type { Observable } from "rxjs";
import { CurrentUser, Roles } from "../auth/decorators";
import type { AuthenticatedUser } from "../auth/jwt-payload";
import type { OrderStatus } from "../../generated/prisma/enums";
import { OrderEventsService, type MerchantEvent } from "./order-events.service";
import {
  AssignDeliveryDto,
  MerchantCancelOrderDto,
  SetItemStatusDto,
  UpdateDeliveryDto,
} from "./dto";
import { MerchantOrdersService } from "./merchant-orders.service";

/**
 * Merchant-side order handling.
 *
 * MERCHANT-only and scoped to the caller's own shop. Mounted under
 * /merchant/orders so it cannot collide with the CUSTOMER-only /orders routes.
 */
@Roles("MERCHANT")
@Controller("merchant/orders")
export class MerchantOrdersController {
  constructor(
    private readonly orders: MerchantOrdersService,
    private readonly events: OrderEventsService,
  ) {}

  /** Drives the dashboard's "new orders" badge. */
  @Get("pending-count")
  pendingCount(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.pendingCount(user.id);
  }

  /**
   * Live events for this shop, over Server-Sent Events.
   *
   * The dashboard used to learn about a new order only on its next 10-second
   * poll. A shop that misses an order ruins the customer's experience, so this
   * pushes instead.
   *
   * AUTH: this goes through the normal global JwtAuthGuard, so it needs an
   * `Authorization: Bearer` header like every other endpoint. The browser's
   * EventSource API cannot set headers, which is why the dashboard consumes
   * this with fetch + a streaming reader instead. The alternative — a token in
   * the query string — would put a 7-day credential into access logs, browser
   * history and any Referer header. Not worth the convenience.
   *
   * The stream is scoped to the caller's own shop inside forMerchant(), so one
   * merchant cannot subscribe to another's orders.
   */
  @Sse("stream")
  stream(@CurrentUser() user: AuthenticatedUser): Observable<{ data: MerchantEvent }> {
    return this.events.sseForMerchant(user.merchantId!);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser, @Query("status") status?: OrderStatus) {
    return this.orders.findAll(user.id, status);
  }

  @Get(":id")
  findOne(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.findOne(user.id, id);
  }

  /** Marks one line confirmed or out of stock while picking. */
  @Patch(":id/items/:itemId")
  setItemStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Body() dto: SetItemStatusDto,
  ) {
    return this.orders.setItemStatus(user.id, id, itemId, dto.status);
  }

  /** Accepts the order: PENDING -> CONFIRMED. */
  @Post(":id/confirm")
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.confirm(user.id, id);
  }

  /** Starts picking: CONFIRMED -> PREPARING. */
  @Post(":id/start-preparing")
  startPreparing(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.startPreparing(user.id, id);
  }

  /** Cancels the order. The reason is mandatory and reaches the customer. */
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: MerchantCancelOrderDto,
  ) {
    return this.orders.cancel(user.id, id, dto.reason);
  }

  /** Assigns a delivery captain by hand (there is no captain app yet). */
  @Post(":id/delivery")
  assignDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AssignDeliveryDto,
  ) {
    return this.orders.assignDelivery(user.id, id, dto);
  }

  /** Moves the delivery along by hand; the order status follows automatically. */
  @Patch(":id/delivery")
  updateDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryDto,
  ) {
    return this.orders.updateDelivery(user.id, id, dto.status, dto.note);
  }
}
