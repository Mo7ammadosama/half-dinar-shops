import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ESCALATION, escalationLevel, type EscalationLevel } from "./escalation-policy";
import { NotificationsService } from "./notifications.service";
import { OrderEventsService } from "./order-events.service";

/**
 * Chases orders the shop has not responded to.
 *
 * new order → shop's response window → still ignored, nudge the shop again →
 * still ignored, tell the admin (and the customer, who could always cancel
 * freely at PENDING — see escalation-policy.ts).
 *
 * The escalation LEVEL is always derived from the order's timestamp (see
 * escalationLevel()), never from a flag or a timer. This service only decides
 * *when to push an alert*, so a dashboard that is already open hears about it
 * immediately rather than on its next poll.
 *
 * That distinction is what makes this survive a restart: timers scheduled
 * before a redeploy are lost, so a periodic sweep re-checks every pending order
 * and alerts on any that the lost timers would have covered. The sweep, not the
 * timer, is the guarantee.
 *
 * ⚠️ SINGLE-INSTANCE ASSUMPTION (fine for the pilot; fix before scaling out).
 * The sweep runs in every instance, and `announced` is an in-memory map, so on
 * N instances a customer would get N escalation pushes and the admin event
 * would fire N times. The *derived* admin queue is unaffected — it is computed
 * from order data — so nothing is wrong or lost; the notifications are just
 * duplicated. The pilot runs one instance. Before running more, either move
 * `announced` into Redis (already a dependency) or elect a single sweeper.
 * Same class of caveat as the in-process SSE Subject in order-events.service.ts.
 */
@Injectable()
export class OrderEscalationService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderEscalationService.name);

  /** Timers for orders placed while this process has been up. */
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  /** Levels already announced, so a sweep does not re-alert every tick. */
  private readonly announced = new Map<string, EscalationLevel>();

  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrderEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Starts the periodic sweep.
   *
   * Called from the module rather than OnModuleInit so tests can opt out — a
   * background timer firing mid-assertion makes for maddening flakes.
   */
  startSweeping(intervalMs = 30_000) {
    this.stopSweeping();
    this.sweepTimer = setInterval(() => void this.sweep(), intervalMs);
    // Do not hold the process open just for the sweep.
    this.sweepTimer.unref?.();
  }

  stopSweeping() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  onModuleDestroy() {
    this.stopSweeping();
    for (const timers of this.timers.values()) timers.forEach(clearTimeout);
    this.timers.clear();
  }

  /**
   * Schedules prompt alerts for a newly placed order.
   *
   * Best-effort only. If this process dies, the sweep picks the order up.
   */
  watchNewOrder(orderId: string, merchantId: string) {
    const at = (seconds: number, level: EscalationLevel) =>
      setTimeout(() => void this.escalateTo(orderId, merchantId, level), seconds * 1000);

    const timers = [
      at(ESCALATION.firstAlertSeconds, 1),
      at(ESCALATION.adminAlertSeconds, 2),
    ];
    timers.forEach((t) => t.unref?.());
    this.timers.set(orderId, timers);
  }

  /** Stops chasing an order the shop has now dealt with. */
  clear(orderId: string) {
    this.timers.get(orderId)?.forEach(clearTimeout);
    this.timers.delete(orderId);
    this.announced.delete(orderId);
  }

  /**
   * Re-checks every pending order and alerts on anything overdue.
   *
   * This is the restart-safe path: after a redeploy, no timers exist, and this
   * is what stops every currently-ignored order being silently forgiven.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.order.findMany({
      where: { status: "PENDING" },
      select: { id: true, merchantId: true, createdAt: true, status: true },
    });

    let alerted = 0;
    for (const order of pending) {
      const level = escalationLevel(order.status, order.createdAt, now);
      if (level === 0) continue;
      if (await this.escalateTo(order.id, order.merchantId, level)) alerted++;
    }
    return alerted;
  }

  /**
   * Announces an escalation, unless this order is already at or past that level.
   *
   * Returns whether anything was actually announced, so the sweep does not
   * re-alert on every tick for the same order.
   */
  private async escalateTo(
    orderId: string,
    merchantId: string,
    level: EscalationLevel,
  ): Promise<boolean> {
    // Re-read the order: it may have been confirmed or cancelled since the
    // timer was set, in which case chasing it would be noise — and a shopkeeper
    // who is alarmed about orders they already handled stops trusting alarms.
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, createdAt: true, customerId: true },
    });
    if (!order) return false;

    // Derived, not trusted from the caller: a stale timer must not escalate an
    // order that has since been dealt with.
    const actual = escalationLevel(order.status, order.createdAt);
    if (actual === 0) {
      this.clear(orderId);
      return false;
    }

    const alreadyAt = this.announced.get(orderId) ?? 0;
    if (actual <= alreadyAt) return false;

    this.announced.set(orderId, actual);

    this.events.emit({
      merchantId,
      type: "order.escalation",
      orderId,
      detail: String(actual),
    });

    if (actual === 2) {
      this.notifications.orderIgnoredEscalatedToAdmin(order.customerId, orderId, merchantId);
      this.logger.warn(`Order ${orderId} ignored by merchant ${merchantId} — admin notified`);
    } else {
      this.logger.log(`Order ${orderId} still unconfirmed — merchant ${merchantId} nudged`);
    }

    return true;
  }
}
