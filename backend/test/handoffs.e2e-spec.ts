import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { NotificationsService } from "../src/orders/notifications.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, uniquePhone } from "./helpers";

/**
 * Handoffs between roles (8.3).
 *
 * A handoff is where one role's action has to change what a DIFFERENT role
 * sees. These are the seams where a product silently breaks: each side works
 * perfectly in isolation, and the message between them goes nowhere.
 *
 * Two the founder named specifically:
 *   - merchant marks an item unavailable  →  the customer decides
 *   - admin suspends a shop               →  the customer's view updates
 *
 * Each test performs the action as one role and then reads back as the other,
 * checking BOTH that the change propagated AND that the receiving side is told
 * clearly enough to act on it.
 */
describe("Handoffs between roles (8.3)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: TestAgent;
  let notifications: NotificationsService;

  let customerToken: string;
  let customerId: string;
  let merchantToken: string;
  let adminToken: string;
  let merchantId: string;

  async function signIn(phone: string) {
    const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
    const verify = await http
      .post("/api/auth/otp/verify")
      .send({ phoneNumber: phone, code: req.body.devCode });
    return { token: verify.body.accessToken as string, userId: verify.body.user.id as string };
  }

  /** Places a real order and walks it to PREPARING. */
  async function orderInPreparing(itemCount = 2) {
    const products = await http
      .get(`/api/shops/${merchantId}/products`)
      .set({ Authorization: `Bearer ${customerToken}` })
      .expect(200);
    const available = products.body
      .filter((p: { isAvailable: boolean }) => p.isAvailable)
      .slice(0, itemCount);

    const order = await http
      .post("/api/orders")
      .set({ Authorization: `Bearer ${customerToken}` })
      .send({
        shopId: merchantId,
        items: available.map((p: { id: string }) => ({ productId: p.id, quantity: 1 })),
      })
      .expect(201);

    await http
      .post(`/api/merchant/orders/${order.body.id}/confirm`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .expect(201);
    await http
      .post(`/api/merchant/orders/${order.body.id}/start-preparing`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .expect(201);

    return order.body.id as string;
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = request(app.getHttpServer());
    notifications = app.get(NotificationsService);

    const customer = await signIn(uniquePhone().replace("+962", "0"));
    customerToken = customer.token;
    customerId = customer.userId;
    merchantToken = (await signIn("0791234567")).token;
    adminToken = (await signIn("0799999999")).token;

    merchantId = (
      await prisma.merchant.findFirstOrThrow({
        where: { shopName: "Al-Nus Dinar Shop" },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    // Leave the pilot shop approved regardless of how a test ended.
    await prisma.merchant.update({ where: { id: merchantId }, data: { status: "APPROVED" } });
    await app.close();
  });

  // ── Handoff 1: shop marks an item unavailable → customer decides ──────────

  describe("shop marks an item unavailable → the customer decides", () => {
    let orderId: string;
    let itemId: string;
    let itemName: string;

    beforeAll(async () => {
      orderId = await orderInPreparing(2);
      const detail = await http
        .get(`/api/merchant/orders/${orderId}`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(200);
      itemId = detail.body.items[0].id;
      itemName = detail.body.items[0].name;

      await http
        .patch(`/api/merchant/orders/${orderId}/items/${itemId}`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ status: "UNAVAILABLE" })
        .expect(200);
    });

    it("REACHES the customer — they are told, by name, which item", async () => {
      const c = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      expect(c.hasUnavailableItems).toBe(true);
      // Named, not just a count: "1 item is unavailable" is useless to someone
      // deciding whether they still want the order.
      expect(c.unavailableItemNames).toContain(itemName);
    });

    it("TELLS the customer what it costs them — the revised total, before deciding", async () => {
      const c = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      // They cannot make the decision without knowing the new price.
      expect(c.revisedTotal).toBeDefined();
      expect(Number(c.revisedTotal)).toBeLessThan(Number(c.totalPrice));
    });

    it("does NOT cancel the order — the shop found ONE item missing, not all of them", async () => {
      const c = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      expect(c.status).toBe("PREPARING");
    });

    it("does NOT change what they pay until they say so", async () => {
      const c = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { totalPrice: true },
      });
      // The stored total is still the original — the shop cannot reprice the
      // order unilaterally.
      expect(order.totalPrice.toFixed(2)).toBe(c.totalPrice);
      expect(c.totalPrice).not.toBe(c.revisedTotal);
    });

    it("fires a notification, so the customer can be told without opening the app", async () => {
      // The seam push hangs off (B6): the handoff is useless if the customer
      // only discovers it by chance.
      const fired = notifications.eventsFor(orderId);
      expect(fired.some((e) => e.type === "order.items_unavailable")).toBe(true);
      expect(fired.find((e) => e.type === "order.items_unavailable")?.detail).toContain(itemName);
    });

    it("COMPLETES when the customer accepts — and only then does the price move", async () => {
      const before = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      await http
        .post(`/api/orders/${orderId}/accept-changes`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(201);

      const after = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      expect(after.totalPrice).toBe(before.revisedTotal);
      expect(after.hasUnavailableItems).toBe(false);
    });
  });

  // ── Handoff 2: admin suspends a shop → customer view updates ──────────────

  describe("admin suspends a shop → the customer's view updates", () => {
    afterEach(async () => {
      // Restore directly rather than through the API: setting a status the shop
      // already has is a deliberate 409 ("This shop is already approved"), so a
      // blanket re-approve here would fail after a test that already restored.
      await prisma.merchant.update({ where: { id: merchantId }, data: { status: "APPROVED" } });
    });

    it("REACHES the customer — the shop disappears from their list", async () => {
      const before = (
        await http.get("/api/shops").set({ Authorization: `Bearer ${customerToken}` }).expect(200)
      ).body;
      expect(before.map((s: { id: string }) => s.id)).toContain(merchantId);

      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "SUSPENDED" })
        .expect(200);

      const after = (
        await http.get("/api/shops").set({ Authorization: `Bearer ${customerToken}` }).expect(200)
      ).body;
      expect(after.map((s: { id: string }) => s.id)).not.toContain(merchantId);
    });

    it("hides the shop's storefront — as NOT FOUND, never 'forbidden'", async () => {
      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "SUSPENDED" })
        .expect(200);

      // 404, not 403: a customer must not even be able to confirm the shop
      // exists. THE APPROVED-ONLY RULE.
      await http
        .get(`/api/shops/${merchantId}`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(404);
      await http
        .get(`/api/shops/${merchantId}/products`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(404);
    });

    it("stops new orders — the customer cannot buy from a suspended shop", async () => {
      const products = await http
        .get(`/api/shops/${merchantId}/products`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(200);
      const one = products.body.find((p: { isAvailable: boolean }) => p.isAvailable);

      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "SUSPENDED" })
        .expect(200);

      await http
        .post("/api/orders")
        .set({ Authorization: `Bearer ${customerToken}` })
        .send({ shopId: merchantId, items: [{ productId: one.id, quantity: 1 }] })
        .expect(404);
    });

    it("REVERSES cleanly — re-approving brings the shop straight back", async () => {
      // A one-way door would make an admin afraid to use the control at all.
      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "SUSPENDED" })
        .expect(200);
      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "APPROVED" })
        .expect(200);

      const shops = (
        await http.get("/api/shops").set({ Authorization: `Bearer ${customerToken}` }).expect(200)
      ).body;
      expect(shops.map((s: { id: string }) => s.id)).toContain(merchantId);
    });

    it("TELLS THE SHOPKEEPER — they see their own suspension, not a silent failure", async () => {
      // The receiving side of this handoff is the merchant too. Being unable to
      // work with no explanation is the worst version of this.
      await http
        .patch(`/api/admin/merchants/${merchantId}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: "SUSPENDED" })
        .expect(200);

      const me = await http
        .get("/api/merchants/me")
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(200);
      expect(me.body.status).toBe("SUSPENDED");
    });
  });

  // ── Handoff 3: merchant cancels → the customer learns why ─────────────────

  describe("shop cancels with a reason → the customer learns WHY", () => {
    it("delivers the shop's own words, verbatim, to the customer", async () => {
      const orderId = await orderInPreparing(1);

      await http
        .post(`/api/merchant/orders/${orderId}/cancel`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ reason: "Our fridge broke down this morning" })
        .expect(201);

      const c = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      expect(c.status).toBe("CANCELLED");
      expect(c.cancelledBy).toBe("MERCHANT");
      // Verbatim — paraphrasing the shop would be worse than saying nothing.
      expect(c.cancellationReason).toBe("Our fridge broke down this morning");

      // And it fires the notification event, so a closed phone can be told.
      const fired = notifications.eventsFor(orderId);
      expect(fired.some((e) => e.type === "order.cancelled_by_merchant")).toBe(true);
    });
  });

  // ── Handoff 4: driver progress → the customer's screen ────────────────────

  describe("shop moves the delivery → the customer's screen follows", () => {
    it("each step the shop takes is visible to the customer", async () => {
      const orderId = await orderInPreparing(1);

      await http
        .post(`/api/merchant/orders/${orderId}/delivery`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ captainName: "Omar", captainPhone: "0791122334" })
        .expect(201);

      const assigned = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      // Assigned, but not yet carrying it: no driver number yet, and the
      // customer can still cancel because the goods are still in the shop.
      expect(assigned.canCancel).toBe(true);

      await http
        .patch(`/api/merchant/orders/${orderId}/delivery`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ status: "PICKED_UP" })
        .expect(200);

      const collected = (
        await http
          .get(`/api/orders/${orderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      expect(collected.status).toBe("DELIVERING");
      // Now they CAN call the driver, and can no longer cancel.
      expect(collected.contact.driverPhone).toBe("+962791122334");
      expect(collected.contact.driverName).toBe("Omar");
      expect(collected.canCancel).toBe(false);
      expect(collected.cancelBlockedReason).toBeTruthy();
    });
  });
});
