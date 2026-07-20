import { Injectable, Logger } from "@nestjs/common";
import { PushService } from "../push/push.service";

/**
 * Customer-facing notification events.
 *
 * This is the single place that decides what is worth telling a customer, and
 * the seam B6 named. It now does two things for each event:
 *
 *   1. Records it (tests assert on this, and it is the audit trail).
 *   2. Pushes it to the customer's phone via PushService — which reaches a
 *      CLOSED phone once a push provider is configured (see docs/PUSH_SETUP.md).
 *
 * Every push is fire-and-forget on purpose: the thing being announced has
 * already happened. An order that was cancelled stays cancelled whether or not
 * the phone could be reached, so a delivery failure must never propagate back
 * into the operation that triggered it.
 */
/**
 * The Android notification channel every order push is routed through.
 *
 * A FRESH id ("orders-v2"), deliberately NOT the original "orders". Android
 * notification channels are IMMUTABLE after first creation — re-declaring an
 * existing channel with new settings (adding a sound) is a silent no-op on any
 * phone that already has it. The first build created "orders" with no explicit
 * sound, so reusing that id would leave already-installed phones silent forever.
 * A new id is guaranteed to be created fresh with the sound-enabled config in
 * each app's src/push.ts. Keep this string identical to the channel id both the
 * merchant app and the customer app create.
 */
export const ORDER_PUSH_CHANNEL_ID = "orders-v2";

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Recorded events, exposed so tests can assert an event actually fired. */
  private readonly emitted: Array<{ type: string; customerId: string; orderId: string; detail?: string }> = [];

  constructor(private readonly push: PushService) {}

  /**
   * A new order has landed — wake the shopkeeper's phone.
   *
   * This is the merchant-side counterpart to the customer notifications below,
   * and the push half of the merchant new-order alert. The dashboard's SSE
   * stream only reaches a shopkeeper whose browser tab is open; a shopkeeper
   * carrying a phone around their shop needs the notification to arrive on a
   * CLOSED app, which is exactly what PushService.notifyUser does. The
   * merchant's own device is registered through the same /auth/devices endpoint
   * the customer app uses — the token identifies the caller, so the same
   * plumbing serves both roles with no new endpoint.
   *
   * Fire-and-forget, like every push here: the order is already committed and
   * real, and a failure to reach the phone must never roll it back. The SSE
   * stream and the merchant app's own polling remain the floor under this.
   */
  newOrderToMerchant(merchantUserId: string, orderId: string) {
    this.emit("order.new_to_merchant", merchantUserId, orderId);
    void this.push
      .notifyUser(merchantUserId, {
        title: "New order",
        body: "A customer just placed an order. Open the app to confirm it.",
        data: { orderId, kind: "new_order" },
        // Route through the sound-enabled channel so the shopkeeper HEARS it on
        // a closed/locked phone — the whole point of this notification.
        channelId: ORDER_PUSH_CHANNEL_ID,
      })
      .catch((error) =>
        this.logger.warn(`New-order push failed for merchant ${merchantUserId}: ${String(error)}`),
      );
  }

  orderCancelledByMerchant(customerId: string, orderId: string, reason: string) {
    this.emit("order.cancelled_by_merchant", customerId, orderId, reason);
    this.pushToCustomer(customerId, orderId, {
      title: "Your order was cancelled",
      // The shop's own words. The spec requires the reason reach the customer,
      // and paraphrasing it would be worse than useless.
      body: `The shop cancelled your order: ${reason}`,
    });
  }

  orderItemsUnavailable(customerId: string, orderId: string, itemNames: string[]) {
    this.emit("order.items_unavailable", customerId, orderId, itemNames.join(", "));
    this.pushToCustomer(customerId, orderId, {
      title: "Some items are out of stock",
      // This one needs the customer to act — the total only changes once they
      // accept — so the notification says so rather than just informing.
      body: `${itemNames.join(", ")} — open the app to confirm your new total.`,
    });
  }

  orderConfirmed(customerId: string, orderId: string) {
    this.emit("order.confirmed", customerId, orderId);
    this.pushToCustomer(customerId, orderId, {
      title: "Order confirmed",
      body: "The shop has your order and is getting it ready.",
    });
  }

  orderStatusChanged(customerId: string, orderId: string, status: string) {
    this.emit("order.status_changed", customerId, orderId, status);

    const friendly = STATUS_MESSAGES[status];
    // Only push what a person would care about. Pushing every internal status
    // change would train the customer to ignore the notifications that matter.
    if (friendly) {
      this.pushToCustomer(customerId, orderId, friendly);
    }
  }

  /**
   * The shop has ignored a new order long enough that the admin is now involved.
   *
   * Fires for the customer (they are waiting and can cancel free of charge) and
   * is logged for the admin, who sees the order in their "not responded to"
   * list — which is derived from order data, so it is correct even if this
   * event is missed. See order-escalation.service.ts.
   */
  orderIgnoredEscalatedToAdmin(customerId: string, orderId: string, merchantId: string) {
    this.emit("order.ignored_escalated_to_admin", customerId, orderId, `merchant ${merchantId}`);
    this.pushToCustomer(customerId, orderId, {
      title: "The shop has not responded",
      body: "You can cancel free of charge, or keep waiting. We have alerted the team.",
    });
  }

  private emit(type: string, customerId: string, orderId: string, detail?: string) {
    this.emitted.push({ type, customerId, orderId, detail });
    this.logger.log(
      `NOTIFY ${type} -> customer ${customerId}, order ${orderId}${detail ? `: ${detail}` : ""}`,
    );
  }

  /**
   * Fire-and-forget delivery to the customer's phone.
   *
   * Not awaited: the caller is mid-transaction on something that has already
   * happened, and must not wait on (or fail because of) a push service.
   * PushService never throws, but the catch is kept as a belt-and-braces so a
   * future change there cannot produce an unhandled rejection.
   */
  private pushToCustomer(
    customerId: string,
    orderId: string,
    message: { title: string; body: string },
  ) {
    void this.push
      .notifyUser(customerId, { ...message, data: { orderId }, channelId: ORDER_PUSH_CHANNEL_ID })
      .catch((error) =>
        this.logger.warn(`Push failed for customer ${customerId}: ${String(error)}`),
      );
  }

  /** Test helper: the events fired for one order. */
  eventsFor(orderId: string) {
    return this.emitted.filter((e) => e.orderId === orderId);
  }
}

/**
 * Which status changes are worth waking a phone for, in the customer's words.
 *
 * Anything absent here is deliberately silent — internal bookkeeping the
 * customer does not need pushed at them.
 */
const STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  PREPARING: {
    title: "Your order is being picked",
    body: "The shop is collecting your items now.",
  },
  DRIVER_ASSIGNED: {
    title: "A driver is on the way to the shop",
    body: "Your order will be collected shortly.",
  },
  DELIVERY_PICKED_UP: {
    title: "Your order is on its way",
    body: "The driver has collected your order.",
  },
  DELIVERY_ON_WAY: {
    title: "Your order is on its way",
    body: "The driver is heading to you now.",
  },
  DELIVERY_DELIVERED: {
    title: "Delivered",
    body: "Your order has arrived. Enjoy!",
  },
  DELIVERY_FAILED: {
    title: "Delivery failed",
    body: "We could not deliver your order. Open the app for details.",
  },
};
