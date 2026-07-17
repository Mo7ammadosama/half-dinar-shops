/**
 * Order lifecycle and cancellation rules, in one place.
 *
 * These encode the founder's spec exactly:
 *
 *   - Customer can cancel FREELY while PENDING (not yet confirmed by the shop).
 *   - Customer can cancel during PREPARING, but is warned first.
 *   - Once DELIVERING, cancellation is BLOCKED for everyone.
 *   - Merchant can cancel only during PREPARING, and must give a reason.
 *
 * The spec does not say what happens in CONFIRMED — the state between the shop
 * accepting an order and starting to pick it. Treating it as uncancellable would
 * mean a shop that just accepted an order cannot cancel until it pretends to
 * start picking, and a customer would be locked in the instant the shop tapped
 * "confirm". Both are worse than the alternative, so CONFIRMED follows the same
 * rules as PREPARING. Recorded in PHASE_REPORTS.md as a chosen default.
 */
import type { DeliveryStatus, OrderStatus } from "../../generated/prisma/enums";

/** Cancel with no warning and no penalty. */
export const CUSTOMER_FREE_CANCEL: readonly OrderStatus[] = ["PENDING"];

/** Cancel allowed, but the app warns first — the shop is already working. */
export const CUSTOMER_WARNED_CANCEL: readonly OrderStatus[] = ["CONFIRMED", "PREPARING"];

/** The shop may cancel here, with a mandatory reason. */
export const MERCHANT_CANCEL_ALLOWED: readonly OrderStatus[] = ["CONFIRMED", "PREPARING"];

/** Items may only be marked unavailable while the shop is still picking. */
export const ITEM_EDIT_ALLOWED: readonly OrderStatus[] = ["PENDING", "CONFIRMED", "PREPARING"];

/** Allowed merchant-driven forward moves. Anything else is rejected. */
export const FORWARD_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ["CONFIRMED"],
  CONFIRMED: ["PREPARING"],
  // DELIVERING is entered in Phase 6 when a delivery is assigned.
  PREPARING: ["DELIVERING"],
  DELIVERING: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export interface CancelDecision {
  allowed: boolean;
  /** True when the customer should be warned before confirming. */
  warn: boolean;
  /** Why it is blocked, phrased for the person reading it. */
  reason?: string;
}

export function customerCancelDecision(status: OrderStatus): CancelDecision {
  if (CUSTOMER_FREE_CANCEL.includes(status)) return { allowed: true, warn: false };
  if (CUSTOMER_WARNED_CANCEL.includes(status)) return { allowed: true, warn: true };

  if (status === "DELIVERING") {
    return {
      allowed: false,
      warn: false,
      reason: "Your order is already on its way and can no longer be cancelled.",
    };
  }
  if (status === "DELIVERED") {
    return { allowed: false, warn: false, reason: "This order has already been delivered." };
  }
  return { allowed: false, warn: false, reason: "This order has already been cancelled." };
}

export function merchantCancelDecision(status: OrderStatus): CancelDecision {
  if (MERCHANT_CANCEL_ALLOWED.includes(status)) return { allowed: true, warn: false };

  if (status === "PENDING") {
    return {
      allowed: false,
      warn: false,
      reason: "Confirm the order before cancelling it, so the customer knows it was seen.",
    };
  }
  if (status === "DELIVERING") {
    return { allowed: false, warn: false, reason: "This order is already out for delivery." };
  }
  if (status === "DELIVERED") {
    return { allowed: false, warn: false, reason: "This order has already been delivered." };
  }
  return { allowed: false, warn: false, reason: "This order has already been cancelled." };
}

export function canMoveTo(from: OrderStatus, to: OrderStatus): boolean {
  return FORWARD_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Direct contact (Phase 7)
// ---------------------------------------------------------------------------

/**
 * When the customer and the shop may call each other.
 *
 * The spec says "merchant <-> customer during preparing". CONFIRMED is included
 * for the same reason it is included in the cancellation rules: it is the same
 * window in practice — the shop has the order and has not sent it out.
 *
 * Phone numbers are gated on the SERVER, not merely hidden in the app: outside
 * this window the shop's number is not in the response at all. Hiding a button
 * while still shipping the number would be theatre.
 */
export const SHOP_CONTACT_WINDOW: readonly OrderStatus[] = ["CONFIRMED", "PREPARING"];

/**
 * When the customer may call the driver.
 *
 * The spec says "customer <-> captain during on_way". PICKED_UP is included
 * because the driver is holding the customer's goods from that moment — if they
 * cannot find the address, a call has to be possible.
 */
export const DRIVER_CONTACT_WINDOW: readonly DeliveryStatus[] = ["PICKED_UP", "ON_WAY"];

/** Reviews are only meaningful once the order actually arrived. */
export const REVIEWABLE_STATUSES: readonly OrderStatus[] = ["DELIVERED"];
