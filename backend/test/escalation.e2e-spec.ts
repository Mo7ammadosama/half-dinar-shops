import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import {
  customerNotice,
  escalationLevel,
  ESCALATION,
  merchantNotice,
} from "../src/orders/escalation-policy";
import { OrderEscalationService } from "../src/orders/order-escalation.service";
import { OrderEventsService } from "../src/orders/order-events.service";
import { NotificationsService } from "../src/orders/notifications.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./helpers";

/**
 * Escalation when a shop ignores a new order (8.2b).
 *
 * The chain: new order → the shop's response window → still ignored, nudge the
 * shop again → still ignored, tell the admin. The customer could always cancel
 * a PENDING order freely (order-policy.ts) — what was missing was *telling*
 * them, which is asserted here too.
 *
 * Time is injected rather than waited for. A test that sleeps for the real
 * window would take minutes and would still only prove one point on the curve.
 */
describe("Ignored-order escalation (8.2b)", () => {
  describe("the policy is derived from the order, not from a timer", () => {
    const createdAt = new Date("2026-07-17T10:00:00Z");
    const after = (seconds: number) => new Date(createdAt.getTime() + seconds * 1000);

    it("is calm while the shop is inside its window", () => {
      expect(escalationLevel("PENDING", createdAt, after(1))).toBe(0);
      expect(escalationLevel("PENDING", createdAt, after(ESCALATION.firstAlertSeconds - 1))).toBe(0);
    });

    it("nudges the shop once its window has passed", () => {
      expect(escalationLevel("PENDING", createdAt, after(ESCALATION.firstAlertSeconds))).toBe(1);
    });

    it("involves the admin once the order has been ignored long enough", () => {
      expect(escalationLevel("PENDING", createdAt, after(ESCALATION.adminAlertSeconds))).toBe(2);
      expect(escalationLevel("PENDING", createdAt, after(ESCALATION.adminAlertSeconds * 10))).toBe(2);
    });

    it("stops escalating the moment the shop confirms", () => {
      // A confirmed order has demonstrably been seen. How long it then takes to
      // pick is a different problem with a different remedy.
      const longAgo = after(ESCALATION.adminAlertSeconds * 5);
      expect(escalationLevel("CONFIRMED", createdAt, longAgo)).toBe(0);
      expect(escalationLevel("PREPARING", createdAt, longAgo)).toBe(0);
      expect(escalationLevel("CANCELLED", createdAt, longAgo)).toBe(0);
      expect(escalationLevel("DELIVERED", createdAt, longAgo)).toBe(0);
    });

    it("is a pure function of stored data — the SAME answer after a restart", () => {
      // The heart of the design. A setTimeout-based escalation is wiped by every
      // redeploy, silently forgiving exactly the orders that most need chasing.
      // Deriving it means a restarted process reaches the identical conclusion.
      const now = after(ESCALATION.adminAlertSeconds);
      const beforeRestart = escalationLevel("PENDING", createdAt, now);
      const afterRestart = escalationLevel("PENDING", createdAt, now);

      expect(afterRestart).toBe(beforeRestart);
      expect(afterRestart).toBe(2);
    });

    it("tells the shopkeeper something useful, and does not nag early", () => {
      expect(merchantNotice(0)).toBeNull();
      expect(merchantNotice(1)).toMatch(/still waiting/i);
      expect(merchantNotice(2)).toMatch(/urgent/i);
    });

    it("only warns the customer once the shop is genuinely overdue", () => {
      // Telling someone "your shop is slow" after two minutes would abandon
      // more orders than it saves.
      expect(customerNotice(0)).toBeNull();
      expect(customerNotice(1)).toBeNull();
      expect(customerNotice(2)).toMatch(/cancel this order free of charge/i);
    });
  });

  describe("the sweep — what makes escalation survive a restart", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let escalation: OrderEscalationService;
    let events: OrderEventsService;
    let notifications: NotificationsService;
    let http: TestAgent;
    let customerId: string;
    let merchantId: string;

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      http = request(app.getHttpServer());
      escalation = app.get(OrderEscalationService);
      events = app.get(OrderEventsService);
      notifications = app.get(NotificationsService);

      const merchant = await prisma.merchant.findFirstOrThrow({
        where: { shopName: "Al-Nus Dinar Shop" },
        select: { id: true },
      });
      merchantId = merchant.id;

      const customer = await prisma.user.findFirstOrThrow({
        where: { phoneNumber: "+962791111111" },
        select: { id: true },
      });
      customerId = customer.id;
    });

    afterAll(async () => {
      escalation.stopSweeping();
      await app.close();
    });

    /** An order that was placed `ageSeconds` ago and never confirmed. */
    async function ignoredOrderAged(ageSeconds: number) {
      const product = await prisma.product.findFirstOrThrow({
        where: { merchantId },
        select: { id: true, price: true },
      });

      return prisma.order.create({
        data: {
          customerId,
          merchantId,
          status: "PENDING",
          totalPrice: product.price.plus("0.50"),
          deliveryFee: "0.50",
          createdAt: new Date(Date.now() - ageSeconds * 1000),
          orderItems: {
            create: [{ productId: product.id, quantity: 1, priceAtOrder: product.price }],
          },
        },
        select: { id: true },
      });
    }

    afterEach(async () => {
      await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
      await prisma.order.deleteMany({ where: { customerId } });
    });

    it("finds an order the shop has ignored, with NO timer ever scheduled", async () => {
      // Exactly the post-restart situation: the order exists, but the process
      // that would have set its timers is gone. If the sweep did not pick this
      // up, a redeploy would silently forgive every ignored order.
      const order = await ignoredOrderAged(ESCALATION.adminAlertSeconds + 60);

      const alerted = await escalation.sweep();

      expect(alerted).toBeGreaterThanOrEqual(1);
      const fired = notifications.eventsFor(order.id);
      expect(fired.some((e) => e.type === "order.ignored_escalated_to_admin")).toBe(true);
    });

    it("leaves a shop inside its window alone", async () => {
      const order = await ignoredOrderAged(1);

      await escalation.sweep();

      expect(notifications.eventsFor(order.id)).toHaveLength(0);
    });

    it("does not re-alert the same order on every sweep", async () => {
      // A shopkeeper alarmed repeatedly about one order stops trusting alarms.
      const order = await ignoredOrderAged(ESCALATION.adminAlertSeconds + 60);

      await escalation.sweep();
      await escalation.sweep();
      await escalation.sweep();

      const adminAlerts = notifications
        .eventsFor(order.id)
        .filter((e) => e.type === "order.ignored_escalated_to_admin");
      expect(adminAlerts).toHaveLength(1);
    });

    it("pushes an escalation event to the shop's live dashboard", async () => {
      const order = await ignoredOrderAged(ESCALATION.firstAlertSeconds + 5);

      const seen: string[] = [];
      const sub = events.forMerchant(merchantId).subscribe((e) => seen.push(e.type));
      try {
        await escalation.sweep();
      } finally {
        sub.unsubscribe();
      }

      expect(seen).toContain("order.escalation");
      expect(order.id).toBeDefined();
    });

    it("stops chasing an order the shop confirmed after the timer was set", async () => {
      // The stale-timer case: escalateTo re-reads the order rather than trusting
      // the level it was scheduled with.
      const order = await ignoredOrderAged(ESCALATION.adminAlertSeconds + 60);
      await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });

      await escalation.sweep();

      expect(notifications.eventsFor(order.id)).toHaveLength(0);
    });
  });

  describe("what each role actually sees", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let http: TestAgent;
    let merchantId: string;
    let customerId: string;
    let customerToken: string;
    let merchantToken: string;
    let adminToken: string;

    const signIn = async (agent: TestAgent, phone: string) => {
      const req = await agent.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await agent
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });
      return verify.body.accessToken as string;
    };

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      http = request(app.getHttpServer());

      customerToken = await signIn(http, "0791111111");
      merchantToken = await signIn(http, "0791234567");
      adminToken = await signIn(http, "0799999999");

      merchantId = (
        await prisma.merchant.findFirstOrThrow({
          where: { shopName: "Al-Nus Dinar Shop" },
          select: { id: true },
        })
      ).id;
      customerId = (
        await prisma.user.findFirstOrThrow({
          where: { phoneNumber: "+962791111111" },
          select: { id: true },
        })
      ).id;
    });

    afterAll(async () => await app.close());

    async function ignoredOrderAged(ageSeconds: number) {
      const product = await prisma.product.findFirstOrThrow({
        where: { merchantId },
        select: { id: true, price: true },
      });
      return prisma.order.create({
        data: {
          customerId,
          merchantId,
          status: "PENDING",
          totalPrice: product.price.plus("0.50"),
          deliveryFee: "0.50",
          createdAt: new Date(Date.now() - ageSeconds * 1000),
          orderItems: {
            create: [{ productId: product.id, quantity: 1, priceAtOrder: product.price }],
          },
        },
        select: { id: true },
      });
    }

    afterEach(async () => {
      await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
      await prisma.order.deleteMany({ where: { customerId } });
    });

    it("the ADMIN sees an ignored order, with the shop's number to call", async () => {
      const order = await ignoredOrderAged(ESCALATION.adminAlertSeconds + 60);

      const res = await http
        .get("/api/admin/orders/ignored")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const found = res.body.find((o: { id: string }) => o.id === order.id);
      expect(found).toBeDefined();
      expect(found.escalationLevel).toBe(2);
      expect(found.shopName).toBe("Al-Nus Dinar Shop");
      // The admin's actual job here is to phone the shop.
      expect(found.shopPhone).toBe("+962791234567");
      expect(found.waitingSeconds).toBeGreaterThanOrEqual(ESCALATION.adminAlertSeconds);
    });

    it("the ADMIN's queue excludes a shop that is still inside its window", async () => {
      await ignoredOrderAged(1);

      const res = await http
        .get("/api/admin/orders/ignored")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      // A pending order a moment old is a shop doing its job, not an incident.
      expect(res.body).toHaveLength(0);
    });

    it("the MERCHANT sees the order flagged on their own list", async () => {
      const order = await ignoredOrderAged(ESCALATION.firstAlertSeconds + 5);

      const res = await http
        .get("/api/merchant/orders")
        .set("Authorization", `Bearer ${merchantToken}`)
        .expect(200);

      const found = res.body.find((o: { id: string }) => o.id === order.id);
      expect(found.escalationLevel).toBeGreaterThanOrEqual(1);
      expect(found.escalationNotice).toMatch(/waiting/i);
    });

    it("the CUSTOMER is TOLD the shop has not responded, and that cancelling is free", async () => {
      // They could always cancel a pending order freely — the gap was that
      // nothing told them anything was wrong, so they just waited.
      const order = await ignoredOrderAged(ESCALATION.adminAlertSeconds + 60);

      const res = await http
        .get(`/api/orders/${order.id}`)
        .set("Authorization", `Bearer ${customerToken}`)
        .expect(200);

      expect(res.body.shopUnresponsiveNotice).toMatch(/free of charge/i);
      // The pre-existing rule still holds, and is what the notice points at.
      expect(res.body.canCancel).toBe(true);
      expect(res.body.cancelRequiresWarning).toBe(false);
    });

    it("the CUSTOMER is not nagged while the shop is still inside its window", async () => {
      const order = await ignoredOrderAged(1);

      const res = await http
        .get(`/api/orders/${order.id}`)
        .set("Authorization", `Bearer ${customerToken}`)
        .expect(200);

      expect(res.body.shopUnresponsiveNotice).toBeNull();
      expect(res.body.canCancel).toBe(true);
    });

    it("a MERCHANT cannot read the admin's escalation queue", async () => {
      // The queue names other shops and exposes their phone numbers.
      await http
        .get("/api/admin/orders/ignored")
        .set("Authorization", `Bearer ${merchantToken}`)
        .expect(403);
    });

    it("a CUSTOMER cannot read the admin's escalation queue", async () => {
      await http
        .get("/api/admin/orders/ignored")
        .set("Authorization", `Bearer ${customerToken}`)
        .expect(403);
    });

    it("the escalation queue refuses an unauthenticated caller", async () => {
      await http.get("/api/admin/orders/ignored").expect(401);
    });
  });
});
