import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import type { DeliveryStatus, OrderStatus } from "../../generated/prisma/enums";
import { PrismaService } from "../prisma/prisma.service";
import {
  canMoveDelivery,
  DELIVERY_ASSIGNABLE_FROM,
  orderStatusForDelivery,
} from "./delivery-policy";
import type { AssignDeliveryDto } from "./dto";
import { escalationLevel, merchantNotice, type EscalationLevel } from "./escalation-policy";
import { NotificationsService } from "./notifications.service";
import { OrderEscalationService } from "./order-escalation.service";
import {
  canMoveTo,
  ITEM_EDIT_ALLOWED,
  merchantCancelDecision,
  SHOP_CONTACT_WINDOW,
} from "./order-policy";

@Injectable()
export class MerchantOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly escalation: OrderEscalationService,
  ) {}

  /** Resolves the caller's shop. Suspended shops cannot work orders. */
  private async requireOwnMerchant(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!merchant) throw new NotFoundException("No shop profile found for this account.");
    if (merchant.status === "SUSPENDED") {
      throw new ForbiddenException("This shop is suspended.");
    }
    return merchant;
  }

  /**
   * Loads one of the shop's own orders.
   *
   * Scoped by merchantId, so another shop's order reads as "not found" rather
   * than "forbidden" — order ids cannot be probed.
   */
  private async requireOwnOrder(merchantId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, merchantId },
      select: { id: true, status: true, customerId: true },
    });
    if (!order) throw new NotFoundException("Order not found.");
    return order;
  }

  /** Shapes an order for the merchant dashboard. */
  private async detail(merchantId: string, orderId: string) {
    const order = await this.prisma.order.findFirstOrThrow({
      where: { id: orderId, merchantId },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        deliveryFee: true,
        cancelledBy: true,
        cancellationReason: true,
        createdAt: true,
        customer: { select: { id: true, phoneNumber: true } },
        delivery: {
          select: {
            id: true,
            captainName: true,
            captainPhone: true,
            status: true,
            deliveredAt: true,
          },
        },
        orderItems: {
          select: {
            id: true,
            quantity: true,
            priceAtOrder: true,
            status: true,
            product: { select: { id: true, name: true, imageUrl: true } },
          },
          orderBy: { id: "asc" },
        },
      },
    });

    // Only CONFIRMED lines count towards what the customer pays.
    const confirmedTotal = order.orderItems
      .filter((i) => i.status === "CONFIRMED")
      .reduce((sum, i) => sum.plus(i.priceAtOrder.times(i.quantity)), new Prisma.Decimal(0));

    const unavailable = order.orderItems.filter((i) => i.status === "UNAVAILABLE");

    return {
      id: order.id,
      status: order.status,
      /**
       * The customer's number, ONLY inside the shop's contact window.
       *
       * Phase 7 gated the customer's view of the shop's number on the server —
       * "hiding a button while still shipping the number would be theatre".
       * That rule is mutual in the spec ("merchant <-> customer during
       * preparing"), but this direction was enforced in the UI only: the
       * dashboard hid the call button outside CONFIRMED/PREPARING while the
       * API returned the number on every order forever, including delivered
       * and cancelled ones. That is exactly the theatre Phase 7 rejected, just
       * pointing the other way. Found by the 8.3 consistency audit.
       *
       * Uses the same SHOP_CONTACT_WINDOW constant as the customer side, so the
       * two directions cannot drift apart again.
       */
      customer: {
        id: order.customer.id,
        phoneNumber: SHOP_CONTACT_WINDOW.includes(order.status)
          ? order.customer.phoneNumber
          : null,
      },
      deliveryFee: order.deliveryFee.toFixed(2),
      /** The stored total — still includes unavailable items until the customer accepts. */
      totalPrice: order.totalPrice.toFixed(2),
      /** What the total WOULD be once the customer accepts the removals. */
      revisedTotal: confirmedTotal.plus(order.deliveryFee).toFixed(2),
      hasUnavailableItems: unavailable.length > 0,
      cancelledBy: order.cancelledBy,
      cancellationReason: order.cancellationReason,
      createdAt: order.createdAt,
      /** Null until a captain is assigned. Phone shown in full — no masking. */
      delivery: order.delivery,
      canAssignDelivery: order.delivery === null && DELIVERY_ASSIGNABLE_FROM.includes(order.status),
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

  /** The shop's orders, newest first. Optionally filtered by status. */
  async findAll(userId: string, status?: OrderStatus) {
    const merchant = await this.requireOwnMerchant(userId);

    const orders = await this.prisma.order.findMany({
      where: { merchantId: merchant.id, ...(status ? { status } : {}) },
      select: {
        id: true,
        status: true,
        totalPrice: true,
        createdAt: true,
        customer: { select: { phoneNumber: true } },
        orderItems: { select: { status: true } },
      },
      orderBy: { createdAt: "desc" },
      /**
       * Bounded. This was unlimited, which meant the shopkeeper's main working
       * screen fetched EVERY order the shop had ever taken — with its items
       * joined — and the Orders tab re-fetches it every 10 seconds. A shop
       * doing 50 orders a day would be re-downloading ~18,000 orders every 10s
       * within a year, and the page would get slower every single day it
       * traded. Found by looking at the screen during the 8.3 audit, not by a
       * test — every test passed against a small dataset.
       *
       * 200 matches the admin's list. The dashboard has no pagination, so
       * nothing beyond this was reachable anyway; newest-first means today's
       * orders — the ones a shopkeeper is actually working — are always there.
       */
      take: 200,
    });

    return orders.map((o) => ({
      id: o.id,
      status: o.status,
      // Same window as the detail view — otherwise the gate there would be
      // pointless, since the number would still be one list request away.
      customerPhone: SHOP_CONTACT_WINDOW.includes(o.status) ? o.customer.phoneNumber : null,
      totalPrice: o.totalPrice.toFixed(2),
      itemCount: o.orderItems.length,
      unavailableCount: o.orderItems.filter((i) => i.status === "UNAVAILABLE").length,
      createdAt: o.createdAt,
      // Derived from the order's own age, not stored — so it is correct after a
      // restart and identical on every instance. See escalation-policy.ts.
      escalationLevel: escalationLevel(o.status, o.createdAt),
      escalationNotice: merchantNotice(escalationLevel(o.status, o.createdAt)),
    }));
  }

  async findOne(userId: string, orderId: string) {
    const merchant = await this.requireOwnMerchant(userId);
    await this.requireOwnOrder(merchant.id, orderId);
    return this.detail(merchant.id, orderId);
  }

  /** How many orders are waiting — drives the dashboard's "new orders" badge. */
  async pendingCount(userId: string) {
    const merchant = await this.requireOwnMerchant(userId);
    const pending = await this.prisma.order.findMany({
      where: { merchantId: merchant.id, status: "PENDING" },
      select: { status: true, createdAt: true },
    });

    // The worst case leads: if any order is overdue, the alert reflects that
    // rather than averaging it away behind newer, calmer ones.
    const worstLevel = pending.reduce<EscalationLevel>((worst, order) => {
      const level = escalationLevel(order.status, order.createdAt);
      return level > worst ? level : worst;
    }, 0);

    return { pending: pending.length, escalationLevel: worstLevel };
  }

  /**
   * Marks a single line confirmed or unavailable.
   *
   * An out-of-stock item does NOT cancel the order — it is flagged, the customer
   * is notified, and the total only changes once the customer accepts the
   * removal (see OrdersService.acceptChanges).
   */
  async setItemStatus(
    userId: string,
    orderId: string,
    itemId: string,
    status: "CONFIRMED" | "UNAVAILABLE",
  ) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    if (!ITEM_EDIT_ALLOWED.includes(order.status)) {
      throw new ConflictException(
        `Items can no longer be changed once the order is ${order.status.toLowerCase()}.`,
      );
    }

    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId },
      select: { id: true, product: { select: { name: true } } },
    });
    if (!item) throw new NotFoundException("Order item not found.");

    await this.prisma.orderItem.update({ where: { id: itemId }, data: { status } });

    if (status === "UNAVAILABLE") {
      this.notifications.orderItemsUnavailable(order.customerId, orderId, [item.product.name]);
    }

    return this.detail(merchant.id, orderId);
  }

  /** Accepts the order: PENDING -> CONFIRMED. */
  async confirm(userId: string, orderId: string) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    if (!canMoveTo(order.status, "CONFIRMED")) {
      throw new ConflictException(
        `An order that is ${order.status.toLowerCase()} cannot be confirmed.`,
      );
    }

    await this.prisma.order.update({ where: { id: orderId }, data: { status: "CONFIRMED" } });
    this.notifications.orderConfirmed(order.customerId, orderId);
    // The shop has demonstrably seen it, so stop chasing. (escalationLevel()
    // derives 0 for any non-PENDING order anyway — this just releases the
    // timers rather than leaving them to fire and be ignored.)
    this.escalation.clear(orderId);

    return this.detail(merchant.id, orderId);
  }

  /** Starts picking: CONFIRMED -> PREPARING. */
  async startPreparing(userId: string, orderId: string) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    if (!canMoveTo(order.status, "PREPARING")) {
      throw new ConflictException(
        `An order that is ${order.status.toLowerCase()} cannot start preparing.`,
      );
    }

    await this.prisma.order.update({ where: { id: orderId }, data: { status: "PREPARING" } });
    this.notifications.orderStatusChanged(order.customerId, orderId, "PREPARING");

    return this.detail(merchant.id, orderId);
  }

  /**
   * Cancels the order. The reason is mandatory and is shown to the customer.
   *
   * The database also enforces that a cancelled order records who cancelled it
   * (`orders_cancelled_by_matches_status`), so this cannot half-happen.
   */
  async cancel(userId: string, orderId: string, reason: string) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    const decision = merchantCancelDecision(order.status);
    if (!decision.allowed) throw new ConflictException(decision.reason);

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException("A cancellation reason is required.");
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledBy: "MERCHANT", cancellationReason: trimmed },
    });

    // The spec requires this to fire immediately on merchant cancellation.
    this.notifications.orderCancelledByMerchant(order.customerId, orderId, trimmed);

    return this.detail(merchant.id, orderId);
  }

  /**
   * Assigns a delivery captain by hand.
   *
   * There is no captain app yet, so the shop types in who is taking it. The
   * captain's real number is stored and shown to the customer — the spec
   * explicitly asks for no masking.
   */
  async assignDelivery(userId: string, orderId: string, dto: AssignDeliveryDto) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    if (!DELIVERY_ASSIGNABLE_FROM.includes(order.status)) {
      throw new ConflictException(
        `A driver can only be assigned once the order is being picked (this one is ${order.status.toLowerCase()}).`,
      );
    }

    const existing = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: { id: true },
    });
    // One delivery per order — the schema enforces it too.
    if (existing) throw new ConflictException("This order already has a driver assigned.");

    await this.prisma.delivery.create({
      data: {
        orderId,
        captainName: dto.captainName.trim(),
        captainPhone: dto.captainPhone,
        status: "ASSIGNED",
      },
    });

    this.notifications.orderStatusChanged(order.customerId, orderId, "DRIVER_ASSIGNED");

    return this.detail(merchant.id, orderId);
  }

  /**
   * Moves a delivery along by hand, keeping the order status in step.
   *
   * The order status is derived from the delivery status rather than set
   * separately, so the two can never contradict each other (see delivery-policy).
   */
  async updateDelivery(
    userId: string,
    orderId: string,
    status: DeliveryStatus,
    note?: string,
  ) {
    const merchant = await this.requireOwnMerchant(userId);
    const order = await this.requireOwnOrder(merchant.id, orderId);

    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: { id: true, status: true },
    });
    if (!delivery) throw new NotFoundException("No driver has been assigned to this order yet.");

    if (!canMoveDelivery(delivery.status, status)) {
      throw new ConflictException(
        `A delivery that is ${delivery.status.toLowerCase().replace("_", " ")} cannot become ${status
          .toLowerCase()
          .replace("_", " ")}.`,
      );
    }

    // A failed delivery cancels the order, so the shop must say why — the
    // customer sees this text.
    if (status === "FAILED" && !note?.trim()) {
      throw new BadRequestException(
        "Please say what went wrong — a failed delivery cancels the order and the customer is told why.",
      );
    }

    const newOrderStatus = orderStatusForDelivery(status);

    // Delivery and order move together or not at all.
    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: delivery.id },
        data: {
          status,
          ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}),
        },
      });

      if (newOrderStatus === "CANCELLED") {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: "CANCELLED",
            cancelledBy: "SYSTEM",
            cancellationReason: `Delivery failed: ${note!.trim()}`,
          },
        });
      } else if (newOrderStatus) {
        await tx.order.update({ where: { id: orderId }, data: { status: newOrderStatus } });
      }
    });

    this.notifications.orderStatusChanged(order.customerId, orderId, `DELIVERY_${status}`);

    return this.detail(merchant.id, orderId);
  }
}
