/**
 * Delivery lifecycle rules.
 *
 * There is no delivery-captain app yet, so a human (shop or admin) moves each
 * delivery along by hand. The captain's name and number are recorded and shown
 * to the customer directly — no masking, as specified.
 *
 * How delivery status drives the ORDER status:
 *
 *   ASSIGNED   -> order stays PREPARING. A captain is named but the bag has not
 *                 left the shop, so the customer may still cancel.
 *   PICKED_UP  -> order becomes DELIVERING. The goods are out; the spec says
 *                 cancellation is blocked from this point.
 *   ON_WAY     -> order stays DELIVERING.
 *   DELIVERED  -> order becomes DELIVERED and delivered_at is stamped.
 *   FAILED     -> order becomes CANCELLED (by SYSTEM), carrying the reason.
 *
 * The FAILED behaviour is a chosen default: the spec lists "failed" as a
 * delivery status but does not say what becomes of the order. Leaving it
 * DELIVERING forever would strand it — nobody could cancel it, because
 * cancellation is blocked at DELIVERING. Cash on delivery means no money has
 * moved, so cancelling is safe and honest; the customer can reorder. A shop that
 * intends to retry simply does not mark it failed. Recorded in PHASE_REPORTS.md.
 */
import type { DeliveryStatus, OrderStatus } from "../../generated/prisma/enums";

/** Allowed delivery moves. Anything else is rejected. */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  ASSIGNED: ["PICKED_UP", "FAILED"],
  PICKED_UP: ["ON_WAY", "DELIVERED", "FAILED"],
  ON_WAY: ["DELIVERED", "FAILED"],
  // Terminal.
  DELIVERED: [],
  FAILED: [],
};

/** The order status implied by a delivery status, or null to leave it alone. */
export function orderStatusForDelivery(status: DeliveryStatus): OrderStatus | null {
  switch (status) {
    case "ASSIGNED":
      return null; // still PREPARING — the bag has not left.
    case "PICKED_UP":
    case "ON_WAY":
      return "DELIVERING";
    case "DELIVERED":
      return "DELIVERED";
    case "FAILED":
      return "CANCELLED";
  }
}

export function canMoveDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

/** A delivery can only be assigned once the shop has actually picked the items. */
export const DELIVERY_ASSIGNABLE_FROM: readonly OrderStatus[] = ["PREPARING"];

/** Plain-language labels for the customer. */
export const DELIVERY_LABEL: Readonly<Record<DeliveryStatus, string>> = {
  ASSIGNED: "A driver has been assigned",
  PICKED_UP: "The driver has collected your order",
  ON_WAY: "Your order is on its way",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
};
