import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "../../generated/prisma/client";
import { APPROVED_ONLY } from "../common/merchant-visibility";
import { PrismaService } from "../prisma/prisma.service";
import { DELIVERY_LABEL } from "./delivery-policy";
import type { CreateOrderDto, CreateReviewDto } from "./dto";
import { customerNotice, escalationLevel } from "./escalation-policy";
import { NotificationsService } from "./notifications.service";
import { OrderEscalationService } from "./order-escalation.service";
import { OrderEventsService } from "./order-events.service";
import {
  customerCancelDecision,
  DRIVER_CONTACT_WINDOW,
  REVIEWABLE_STATUSES,
  SHOP_CONTACT_WINDOW,
} from "./order-policy";

/** Money helper: Prisma Decimal from a fixed-2 string, never a float. */
function money(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(typeof value === "number" ? value.toFixed(2) : value);
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly orderEvents: OrderEventsService,
    private readonly escalation: OrderEscalationService,
  ) {}

  /** Flat delivery fee for the pilot. Configurable; see DELIVERY_FEE_JOD. */
  private deliveryFee(): Prisma.Decimal {
    return money(this.config.getOrThrow<string>("DELIVERY_FEE_JOD"));
  }

  /**
   * Places an order (cash on delivery).
   *
   * Two rules dominate this method:
   *
   *  1. **Prices come from the database, never the client.** The DTO has no
   *     price field at all; the current product price is read here and written
   *     to `price_at_order` as an immutable snapshot. That snapshot is what the
   *     customer pays, even if the merchant reprices the product a second later.
   *
   *  2. **Only APPROVED shops can be ordered from**, matching what the customer
   *     is allowed to see.
   *
   * Everything runs in one transaction: reading the prices and writing the order
   * must not straddle a concurrent price change.
   */
  async create(customerId: string, dto: CreateOrderDto) {
    // Reject duplicate lines rather than guessing intent — the client is
    // responsible for merging a cart before sending it.
    const ids = dto.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException("The same product appears more than once. Merge the quantities.");
    }

    const deliveryFee = this.deliveryFee();

    const placed = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.merchant.findFirst({
        where: { id: dto.shopId, ...APPROVED_ONLY },
        // userId is carried out so the shopkeeper's phone can be pushed to after
        // commit — order.new is emitted with the shop id, not the user id.
        select: { id: true, userId: true },
      });
      // 404, not 403: an unapproved shop must look like it does not exist.
      if (!shop) throw new NotFoundException("Shop not found.");

      // Scoped to this shop, so a product id from another shop simply is not found.
      const products = await tx.product.findMany({
        where: { id: { in: ids }, merchantId: shop.id },
        select: { id: true, name: true, price: true, isAvailable: true },
      });

      if (products.length !== ids.length) {
        const found = new Set(products.map((p) => p.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new BadRequestException(
          `${missing.length} item(s) are not sold by this shop and cannot be ordered.`,
        );
      }

      const unavailable = products.filter((p) => !p.isAvailable);
      if (unavailable.length > 0) {
        throw new BadRequestException(
          `These items are out of stock: ${unavailable.map((p) => p.name).join(", ")}`,
        );
      }

      const byId = new Map(products.map((p) => [p.id, p]));

      // Sum in Decimal throughout — floats would drift across many 0.50 items.
      let itemsTotal = new Prisma.Decimal(0);
      const lines = dto.items.map((item) => {
        const product = byId.get(item.productId)!;
        itemsTotal = itemsTotal.plus(product.price.times(item.quantity));
        return {
          productId: product.id,
          quantity: item.quantity,
          // The snapshot. Never recalculated from the product later.
          priceAtOrder: product.price,
        };
      });

      const order = await tx.order.create({
        data: {
          customerId,
          merchantId: shop.id,
          status: "PENDING",
          totalPrice: itemsTotal.plus(deliveryFee),
          deliveryFee,
          orderItems: { create: lines },
        },
        select: { id: true },
      });

      return {
        ...(await this.findOneWithin(tx, customerId, order.id)),
        merchantId: shop.id,
        merchantUserId: shop.userId,
      };
    });

    // Alert the shop AFTER the transaction commits, never inside it.
    //
    // Emitting within the transaction would ring the shopkeeper's alarm for an
    // order that could still roll back — they would go looking for an order
    // that does not exist. The event is also deliberately outside any
    // try/catch-and-rethrow: a failure to notify must not fail the customer's
    // order, which is already committed and real.
    this.orderEvents.emit({
      merchantId: placed.merchantId,
      type: "order.new",
      orderId: placed.id,
    });
    // Push the new order to the shopkeeper's phone (merchant app, launch blocker
    // B6b for the merchant side). Foreground shops still get the SSE event above
    // and the app's own poll; this is what reaches a backgrounded/closed phone.
    this.notifications.newOrderToMerchant(placed.merchantUserId, placed.id);
    this.escalation.watchNewOrder(placed.id, placed.merchantId);

    // merchantId / merchantUserId are internal routing detail, never part of the
    // customer's view of their own order.
    const { merchantId: _merchantId, merchantUserId: _merchantUserId, ...customerView } = placed;
    return customerView;
  }

  /** Shapes an order for the API. Money is serialized as fixed-2 strings. */
  private async findOneWithin(
    tx: Prisma.TransactionClient | PrismaService,
    customerId: string,
    orderId: string,
  ) {
    const order = await tx.order.findFirst({
      // Scoped by customerId: one customer can never read another's order.
      where: { id: orderId, customerId },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        deliveryFee: true,
        cancelledBy: true,
        cancellationReason: true,
        createdAt: true,
        merchant: {
          select: { id: true, shopName: true, user: { select: { phoneNumber: true } } },
        },
        delivery: {
          select: { captainName: true, captainPhone: true, status: true, deliveredAt: true },
        },
        review: { select: { id: true, rating: true, comment: true } },
        orderItems: {
          select: {
            id: true,
            quantity: true,
            priceAtOrder: true,
            status: true,
            // NOTE: the product's *current* price is deliberately NOT selected.
            // Everything money-related below must come from priceAtOrder — the
            // snapshot — so there is nothing here to accidentally revalue with.
            product: { select: { id: true, name: true, imageUrl: true } },
          },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!order) throw new NotFoundException("Order not found.");

    const itemsTotal = order.orderItems.reduce(
      (sum, i) => sum.plus(i.priceAtOrder.times(i.quantity)),
      new Prisma.Decimal(0),
    );

    // What the customer would pay if they accept the shop's removals. Shown
    // alongside the current total; `totalPrice` only changes once they accept.
    const confirmedTotal = order.orderItems
      .filter((i) => i.status === "CONFIRMED")
      .reduce((sum, i) => sum.plus(i.priceAtOrder.times(i.quantity)), new Prisma.Decimal(0));

    const unavailableItems = order.orderItems.filter((i) => i.status === "UNAVAILABLE");
    const cancelDecision = customerCancelDecision(order.status);

    // Numbers are included only inside their contact window. Outside it they are
    // absent from the response entirely — not merely hidden by the app.
    const canCallShop = SHOP_CONTACT_WINDOW.includes(order.status);
    const canCallDriver =
      order.delivery !== null && DRIVER_CONTACT_WINDOW.includes(order.delivery.status);

    return {
      id: order.id,
      status: order.status,
      shop: { id: order.merchant.id, shopName: order.merchant.shopName },
      contact: {
        /** The shop's number, only while they are working on the order. */
        shopPhone: canCallShop ? order.merchant.user.phoneNumber : null,
        /** The driver's number, only while they are carrying the order. */
        driverPhone: canCallDriver ? order.delivery!.captainPhone : null,
        driverName: canCallDriver ? order.delivery!.captainName : null,
      },
      review: order.review,
      canReview: REVIEWABLE_STATUSES.includes(order.status) && order.review === null,
      itemsTotal: itemsTotal.toFixed(2),
      deliveryFee: order.deliveryFee.toFixed(2),
      totalPrice: order.totalPrice.toFixed(2),
      /** The total once out-of-stock items are removed. Equals totalPrice when there are none. */
      revisedTotal: confirmedTotal.plus(order.deliveryFee).toFixed(2),
      hasUnavailableItems: unavailableItems.length > 0,
      unavailableItemNames: unavailableItems.map((i) => i.product.name),
      canCancel: cancelDecision.allowed,
      cancelRequiresWarning: cancelDecision.warn,
      cancelBlockedReason: cancelDecision.reason ?? null,
      /**
       * Told, not just permitted.
       *
       * The customer could ALWAYS cancel a pending order freely — that rule
       * already existed. What they had no way of knowing was that the shop had
       * not looked at it, so they waited in silence. Null until the shop is
       * genuinely overdue; nagging after two minutes would abandon more orders
       * than it saves. See escalation-policy.ts.
       */
      shopUnresponsiveNotice: customerNotice(escalationLevel(order.status, order.createdAt)),
      cancelledBy: order.cancelledBy,
      cancellationReason: order.cancellationReason,
      createdAt: order.createdAt,
      paymentMethod: "cash_on_delivery" as const,
      /**
       * The driver, once assigned. Name and full phone number are shown to the
       * customer deliberately — the spec asks for no number masking.
       */
      delivery: order.delivery
        ? {
            captainName: order.delivery.captainName,
            captainPhone: order.delivery.captainPhone,
            status: order.delivery.status,
            statusLabel: DELIVERY_LABEL[order.delivery.status],
            deliveredAt: order.delivery.deliveredAt,
          }
        : null,
      items: order.orderItems.map((i) => ({
        id: i.id,
        productId: i.product.id,
        name: i.product.name,
        imageUrl: i.product.imageUrl,
        quantity: i.quantity,
        priceAtOrder: i.priceAtOrder.toFixed(2),
        lineTotal: i.priceAtOrder.times(i.quantity).toFixed(2),
        status: i.status,
      })),
    };
  }

  /** The caller's own orders, newest first. */
  async findAll(customerId: string) {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        createdAt: true,
        merchant: { select: { shopName: true } },
        _count: { select: { orderItems: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return orders.map((o) => ({
      id: o.id,
      status: o.status,
      shopName: o.merchant.shopName,
      totalPrice: o.totalPrice.toFixed(2),
      itemCount: o._count.orderItems,
      createdAt: o.createdAt,
    }));
  }

  /** One of the caller's own orders. */
  async findOne(customerId: string, orderId: string) {
    return this.findOneWithin(this.prisma, customerId, orderId);
  }

  /** The current delivery fee, so the app can show it before checkout. */
  quote() {
    return { deliveryFee: this.deliveryFee().toFixed(2), paymentMethod: "cash_on_delivery" };
  }

  /**
   * Cancels the customer's own order.
   *
   * Free while PENDING; allowed but warned during CONFIRMED/PREPARING (the app
   * shows the warning — the server does not need it to, but reports `warn` so
   * the app knows); blocked once DELIVERING. See order-policy.ts.
   *
   * Cash on delivery means no money has moved, so there is nothing to refund.
   */
  async cancel(customerId: string, orderId: string, reason?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found.");

    const decision = customerCancelDecision(order.status);
    if (!decision.allowed) throw new ConflictException(decision.reason);

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: "CANCELLED",
        cancelledBy: "CUSTOMER",
        // The database requires a cancelled order to record who cancelled it;
        // a customer reason is optional, so fall back to a plain statement.
        cancellationReason: reason?.trim() || "Cancelled by the customer.",
      },
    });

    return this.findOne(customerId, orderId);
  }

  /** Tells the app whether cancelling is allowed, and whether to warn first. */
  async cancelPolicy(customerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException("Order not found.");

    const decision = customerCancelDecision(order.status);
    return {
      status: order.status,
      canCancel: decision.allowed,
      requiresWarning: decision.warn,
      reason: decision.reason ?? null,
    };
  }

  /**
   * Leaves a review, once, after delivery.
   *
   * Only the customer who placed the order can review it, only once it has
   * actually arrived, and only once — so reviews cannot be farmed or left for an
   * order that never came. The unique constraint on `reviews.order_id` and the
   * 1..5 CHECK constraint back this up at the database level.
   */
  async review(customerId: string, orderId: string, dto: CreateReviewDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: { id: true, status: true, review: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found.");

    if (!REVIEWABLE_STATUSES.includes(order.status)) {
      throw new ConflictException("You can only review an order once it has been delivered.");
    }
    if (order.review) {
      throw new ConflictException("You have already reviewed this order.");
    }

    await this.prisma.review.create({
      data: { orderId, rating: dto.rating, comment: dto.comment?.trim() || null },
    });

    return this.findOne(customerId, orderId);
  }

  /**
   * The customer accepts the removal of items the shop found out of stock.
   *
   * Only now does `total_price` change — the spec is explicit that the total
   * recalculates *once the customer confirms removal*, not the moment the shop
   * flags an item. Until then the customer sees the original total alongside
   * what it would become.
   *
   * If every item is gone there is nothing to deliver, so the order is cancelled
   * by the SYSTEM rather than leaving the customer paying a delivery fee for an
   * empty bag.
   */
  async acceptChanges(customerId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, customerId },
        select: {
          id: true,
          status: true,
          deliveryFee: true,
          orderItems: { select: { id: true, status: true, quantity: true, priceAtOrder: true } },
        },
      });
      if (!order) throw new NotFoundException("Order not found.");

      if (order.status === "CANCELLED" || order.status === "DELIVERED") {
        throw new ConflictException("This order is already finished.");
      }

      const unavailable = order.orderItems.filter((i) => i.status === "UNAVAILABLE");
      if (unavailable.length === 0) {
        throw new ConflictException("There are no out-of-stock items to remove from this order.");
      }

      const remaining = order.orderItems.filter((i) => i.status === "CONFIRMED");

      if (remaining.length === 0) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: "CANCELLED",
            cancelledBy: "SYSTEM",
            cancellationReason: "Every item in the order was out of stock.",
          },
        });
        return this.findOneWithin(tx, customerId, orderId);
      }

      // Drop the unavailable lines and recalculate from the surviving snapshots.
      await tx.orderItem.deleteMany({ where: { id: { in: unavailable.map((i) => i.id) } } });

      const itemsTotal = remaining.reduce(
        (sum, i) => sum.plus(i.priceAtOrder.times(i.quantity)),
        new Prisma.Decimal(0),
      );

      await tx.order.update({
        where: { id: orderId },
        data: { totalPrice: itemsTotal.plus(order.deliveryFee) },
      });

      return this.findOneWithin(tx, customerId, orderId);
    });
  }
}
