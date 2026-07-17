/**
 * What happens when a shop ignores a new order.
 *
 * The failure this addresses: an order arrives, nobody at the shop notices, and
 * the customer sits waiting with no idea anything is wrong. Nothing in the
 * product previously escalated — a missed order stayed missed.
 *
 * THE KEY DESIGN DECISION: escalation level is **derived from the order's own
 * timestamp and status**, never stored as a flag or held in a timer.
 *
 * A timer-based design (setTimeout at order creation) looks simpler and is
 * quietly broken: every pending escalation dies on restart. Redeploy the API
 * and every order currently being ignored is silently forgiven — precisely the
 * orders that most need chasing, forgotten by the mechanism meant to catch
 * them. Deriving the level means the answer is correct after any restart, is
 * the same on every instance, and cannot drift from reality.
 *
 * Timers are still used, but ONLY to push an alert promptly to a dashboard that
 * is already connected. They are an optimisation over the derived truth, never
 * the source of it.
 *
 * NOTE ON THE CUSTOMER: the spec's "let the customer cancel" step needs no new
 * rule — an ignored order is still PENDING, and CUSTOMER_FREE_CANCEL already
 * allows a free, unwarned cancel there (see order-policy.ts). Adding a second
 * path would duplicate a rule that exists. What was missing is the customer
 * being *told*, which is what `customerNotice` below provides.
 */
import "dotenv/config";
import type { OrderStatus } from "../../generated/prisma/enums";

function seconds(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer number of seconds, got "${raw}".`);
  }
  return parsed;
}

/**
 * How long the shop gets before each step. Configurable because the tests must
 * not wait real minutes, and because the right value is a business call the
 * founder may want to tune once real shops are using it.
 */
export const ESCALATION = {
  /** Nudge the shop again after this long unacknowledged. */
  firstAlertSeconds: seconds("ESCALATION_FIRST_ALERT_SECONDS", 120),
  /** Tell the admin after this long unacknowledged. */
  adminAlertSeconds: seconds("ESCALATION_ADMIN_ALERT_SECONDS", 300),
} as const;

/** 0 = fine, 1 = shop nudged again, 2 = admin involved. */
export type EscalationLevel = 0 | 1 | 2;

/**
 * Only PENDING counts as "ignored".
 *
 * Once a shop confirms, it has demonstrably seen the order; how long it then
 * takes to pick is a different problem with a different remedy.
 */
export const ESCALATABLE_STATUSES: readonly OrderStatus[] = ["PENDING"];

/**
 * Works out how badly an order has been ignored, from data alone.
 *
 * `now` is injected so tests can reason about elapsed time without sleeping.
 */
export function escalationLevel(
  status: OrderStatus,
  createdAt: Date,
  now: Date = new Date(),
): EscalationLevel {
  if (!ESCALATABLE_STATUSES.includes(status)) return 0;

  const elapsedSeconds = (now.getTime() - createdAt.getTime()) / 1000;
  if (elapsedSeconds >= ESCALATION.adminAlertSeconds) return 2;
  if (elapsedSeconds >= ESCALATION.firstAlertSeconds) return 1;
  return 0;
}

/** What the shopkeeper should see. Plain, urgent, and not a scolding. */
export function merchantNotice(level: EscalationLevel): string | null {
  if (level === 1) return "This order is still waiting — please confirm or cancel it.";
  if (level === 2) return "URGENT: this order has been waiting a long time. The admin has been notified.";
  return null;
}

/**
 * What the customer should see.
 *
 * They can already cancel freely at PENDING; the point is to stop them waiting
 * in silence, wondering. Only shown at level 2 — telling someone "your shop is
 * slow" after two minutes would cause more abandoned orders than it prevents.
 */
export function customerNotice(level: EscalationLevel): string | null {
  if (level === 2) {
    return "The shop has not responded yet. You can cancel this order free of charge, or keep waiting.";
  }
  return null;
}
