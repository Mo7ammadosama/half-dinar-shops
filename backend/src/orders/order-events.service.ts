import { Injectable, Logger } from "@nestjs/common";
import { filter, map, Observable, Subject } from "rxjs";

/** What the merchant dashboard is told about. */
export type MerchantEventType =
  | "order.new"
  | "order.escalation"
  | "order.changed";

export interface MerchantEvent {
  /** The merchant this event belongs to — used to fan out to the right shop. */
  merchantId: string;
  type: MerchantEventType;
  orderId: string;
  /** Free-form detail, e.g. an escalation level. */
  detail?: string;
  at: string;
}

/**
 * Live merchant events, delivered over Server-Sent Events.
 *
 * The dashboard used to poll every 10 seconds, so a new order could sit unseen
 * for that long before the shopkeeper's screen even knew about it. Missing an
 * order is the single worst failure in this product — the customer waits, and
 * nothing tells them anything is wrong — so the notification path is push, not
 * poll.
 *
 * NOTE ON SCOPE: this is an in-process Subject, so it fans out to clients
 * connected to *this instance*. With one API instance (the pilot) that is
 * complete. Behind a load balancer, a merchant connected to instance A would
 * not see an event emitted on instance B — at which point this Subject should
 * be backed by Redis pub/sub. **The dashboard's polling fallback covers exactly
 * this case**, which is why the poll was kept rather than deleted. Documented
 * in docs/MERCHANT_ALERTS.md.
 */
@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly events = new Subject<MerchantEvent>();

  /** Emits an event to every dashboard currently watching this shop. */
  emit(event: Omit<MerchantEvent, "at">) {
    const full: MerchantEvent = { ...event, at: new Date().toISOString() };
    this.logger.log(`EVENT ${full.type} -> merchant ${full.merchantId}, order ${full.orderId}`);
    this.events.next(full);
  }

  /** The stream for one shop. Other shops' events are filtered out here. */
  forMerchant(merchantId: string): Observable<MerchantEvent> {
    return this.events.pipe(filter((event) => event.merchantId === merchantId));
  }

  /** SSE-shaped stream for the controller. */
  sseForMerchant(merchantId: string): Observable<{ data: MerchantEvent }> {
    return this.forMerchant(merchantId).pipe(map((data) => ({ data })));
  }
}
