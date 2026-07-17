import {
  Body,
  Controller,
  Get,
  Module,
  type OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { CurrentUser, Roles } from "../auth/decorators";
import type { AuthenticatedUser } from "../auth/jwt-payload";
import { CreateOrderDto, CreateReviewDto, CustomerCancelOrderDto } from "./dto";
import { MerchantOrdersController } from "./merchant-orders.controller";
import { MerchantOrdersService } from "./merchant-orders.service";
import { NotificationsService } from "./notifications.service";
import { OrderEscalationService } from "./order-escalation.service";
import { OrderEventsService } from "./order-events.service";
import { OrdersService } from "./orders.service";

/**
 * Customer order placement, history and cancellation.
 *
 * CUSTOMER-only: a merchant must not place orders against their own shop.
 * Merchant-side handling lives in MerchantOrdersController.
 */
@Roles("CUSTOMER")
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** The delivery fee, so the cart can show a total before checkout. */
  @Get("quote")
  quote() {
    return this.orders.quote();
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.findAll(user.id);
  }

  @Get(":id")
  findOne(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.findOne(user.id, id);
  }

  /** Whether this order can be cancelled, and whether to warn first. */
  @Get(":id/cancel-policy")
  cancelPolicy(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.cancelPolicy(user.id, id);
  }

  /** Places an order. Cash on delivery — no payment is taken. */
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.orders.create(user.id, dto);
  }

  /** Cancels the customer's own order, subject to the status rules. */
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CustomerCancelOrderDto,
  ) {
    return this.orders.cancel(user.id, id, dto.reason);
  }

  /** Accepts removal of items the shop found out of stock; recalculates the total. */
  @Post(":id/accept-changes")
  acceptChanges(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orders.acceptChanges(user.id, id);
  }

  /** Leaves a review. Only after delivery, and only once. */
  @Post(":id/review")
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.orders.review(user.id, id, dto);
  }
}

@Module({
  controllers: [OrdersController, MerchantOrdersController],
  providers: [
    OrdersService,
    MerchantOrdersService,
    NotificationsService,
    OrderEventsService,
    OrderEscalationService,
  ],
  exports: [NotificationsService, OrderEventsService, OrderEscalationService],
})
export class OrdersModule implements OnModuleInit {
  constructor(private readonly escalation: OrderEscalationService) {}

  /**
   * Starts the escalation sweep once the app is running.
   *
   * Started here rather than inside the service's own OnModuleInit so tests can
   * boot the app without a background timer firing mid-assertion. The sweep is
   * what makes escalation survive a restart — see order-escalation.service.ts.
   */
  onModuleInit() {
    if (process.env.DISABLE_ESCALATION_SWEEP === "true") return;
    this.escalation.startSweeping();
  }
}
