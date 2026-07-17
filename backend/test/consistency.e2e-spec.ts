import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, uniquePhone } from "./helpers";

/**
 * One order, three views — do they agree? (8.3)
 *
 * The customer, the shopkeeper and the admin each look at the same order
 * through a different endpoint. If those three disagree about the status, the
 * price, or which items are in it, then somebody is looking at a lie — and the
 * conversation that follows ("my app says X" / "my screen says Y") is
 * unwinnable for everyone.
 *
 * This drives a real order through its whole life and, at every step, reads it
 * back through all three APIs and compares them.
 */
describe("One order, three views (8.3)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: TestAgent;

  let customerToken: string;
  let merchantToken: string;
  let adminToken: string;
  let customerId: string;
  let merchantId: string;
  let orderId: string;

  async function signIn(phone: string) {
    const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
    const verify = await http
      .post("/api/auth/otp/verify")
      .send({ phoneNumber: phone, code: req.body.devCode });
    return { token: verify.body.accessToken as string, userId: verify.body.user.id as string };
  }

  /** The order as the CUSTOMER sees it. */
  const customerView = async () =>
    (
      await http
        .get(`/api/orders/${orderId}`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(200)
    ).body;

  /** The order as the SHOPKEEPER sees it. */
  const merchantView = async () =>
    (
      await http
        .get(`/api/merchant/orders/${orderId}`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(200)
    ).body;

  /** The order as the ADMIN sees it, from their all-orders list. */
  const adminView = async () => {
    const res = await http
      .get("/api/admin/orders")
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    return res.body.find((o: { id: string }) => o.id === orderId);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = request(app.getHttpServer());

    const customerPhone = uniquePhone().replace("+962", "0");
    const customer = await signIn(customerPhone);
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

    // A real order, placed through the real API as a customer would.
    const products = await http
      .get(`/api/shops/${merchantId}/products`)
      .set({ Authorization: `Bearer ${customerToken}` })
      .expect(200);
    const available = products.body.filter((p: { isAvailable: boolean }) => p.isAvailable).slice(0, 2);

    const order = await http
      .post("/api/orders")
      .set({ Authorization: `Bearer ${customerToken}` })
      .send({
        shopId: merchantId,
        items: available.map((p: { id: string }) => ({ productId: p.id, quantity: 2 })),
      })
      .expect(201);
    orderId = order.body.id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.delivery.deleteMany({ where: { orderId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await app.close();
  });

  it("all three agree the order EXISTS and is the same order", async () => {
    const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
    expect(c.id).toBe(orderId);
    expect(m.id).toBe(orderId);
    expect(a?.id).toBe(orderId);
  });

  it("all three agree on the STATUS, at every stage of the order's life", async () => {
    // Status is the field a customer and a shopkeeper actually argue about, so
    // it is checked at every transition rather than once.
    const stages: string[] = [];

    const check = async (expected: string) => {
      const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
      expect(c.status).toBe(expected);
      expect(m.status).toBe(expected);
      expect(a.status).toBe(expected);
      stages.push(expected);
    };

    await check("PENDING");

    await http
      .post(`/api/merchant/orders/${orderId}/confirm`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .expect(201);
    await check("CONFIRMED");

    await http
      .post(`/api/merchant/orders/${orderId}/start-preparing`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .expect(201);
    await check("PREPARING");

    await http
      .post(`/api/merchant/orders/${orderId}/delivery`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .send({ captainName: "Sami", captainPhone: "0791122334" })
      .expect(201);
    // Assigning a driver does not move the order to DELIVERING — the goods are
    // still in the shop. All three must reflect that same rule.
    await check("PREPARING");

    await http
      .patch(`/api/merchant/orders/${orderId}/delivery`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .send({ status: "PICKED_UP" })
      .expect(200);
    await check("DELIVERING");

    await http
      .patch(`/api/merchant/orders/${orderId}/delivery`)
      .set({ Authorization: `Bearer ${merchantToken}` })
      .send({ status: "DELIVERED" })
      .expect(200);
    await check("DELIVERED");

    expect(stages).toEqual([
      "PENDING",
      "CONFIRMED",
      "PREPARING",
      "PREPARING",
      "DELIVERING",
      "DELIVERED",
    ]);
  });

  it("all three agree on the TOTAL PRICE, to the exact fils", async () => {
    const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
    // Fixed-2 strings everywhere — never a float, and never a different
    // rounding per view.
    expect(c.totalPrice).toMatch(/^\d+\.\d{2}$/);
    expect(m.totalPrice).toBe(c.totalPrice);
    expect(a.totalPrice).toBe(c.totalPrice);
  });

  it("all three agree on HOW MANY ITEMS are in the order", async () => {
    const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
    expect(m.items).toHaveLength(c.items.length);
    expect(a.itemCount).toBe(c.items.length);
  });

  it("the customer and the shopkeeper agree on each item's NAME, QUANTITY and PRICE", async () => {
    const [c, m] = await Promise.all([customerView(), merchantView()]);

    interface Line {
      name: string;
      quantity: number;
      priceAtOrder: string;
    }
    const byName = (items: Line[]) => [...items].sort((x, y) => x.name.localeCompare(y.name));

    const cItems = byName(c.items as Line[]);
    const mItems = byName(m.items as Line[]);

    for (let i = 0; i < cItems.length; i++) {
      expect(mItems[i].name).toBe(cItems[i].name);
      expect(mItems[i].quantity).toBe(cItems[i].quantity);
      // The snapshotted price, identical on both sides.
      expect(mItems[i].priceAtOrder).toBe(cItems[i].priceAtOrder);
    }
  });

  it("all three agree on WHEN the order was placed", async () => {
    const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
    // Compared as instants, not strings: a timezone or format difference would
    // make the same moment look like two different times to two people.
    expect(new Date(m.createdAt).getTime()).toBe(new Date(c.createdAt).getTime());
    expect(new Date(a.createdAt).getTime()).toBe(new Date(c.createdAt).getTime());
  });

  it("the customer and the admin agree on the SHOP's identity", async () => {
    const [c, a] = await Promise.all([customerView(), adminView()]);
    expect(a.shopName).toBe(c.shop.shopName);
  });

  /**
   * The one place the three views are SUPPOSED to differ — and why.
   *
   * Found by this audit: the dashboard hid the "Call the customer" button
   * outside CONFIRMED/PREPARING, but the API returned the number on every
   * order regardless — exactly the "hiding a button while still shipping the
   * number" theatre that Phase 7 rejected for the customer's side. The
   * customer→shop direction was server-enforced; the shop→customer direction
   * was UI-only. Now both use the same SHOP_CONTACT_WINDOW constant.
   */
  describe("the customer's phone number is withheld from the shop outside its window", () => {
    it("the shop CANNOT see it once the order is delivered", async () => {
      // This order is DELIVERED by now (previous test walked it there).
      const m = await merchantView();
      expect(m.status).toBe("DELIVERED");
      expect(m.customer.phoneNumber).toBeNull();
    });

    it("...and cannot get it from the order LIST either", async () => {
      // Otherwise gating the detail view would be pointless — the number would
      // still be one list request away.
      const res = await http
        .get("/api/merchant/orders")
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(200);
      const row = res.body.find((o: { id: string }) => o.id === orderId);
      expect(row.customerPhone).toBeNull();
    });

    it("but the ADMIN still sees it — they arbitrate disputes", async () => {
      // A deliberate, documented asymmetry: the admin's job is to sort out the
      // argument after the fact, which needs both parties' numbers.
      const a = await adminView();
      expect(a.customerPhone).toMatch(/^\+9627\d{8}$/);
    });
  });

  it("all three agree on the DRIVER", async () => {
    const [c, m, a] = await Promise.all([customerView(), merchantView(), adminView()]);
    expect(m.delivery.captainName).toBe("Sami");
    expect(a.delivery.captainName).toBe("Sami");
    // The customer sees the driver's name too, once they are carrying it.
    expect(c.contact.driverName ?? m.delivery.captainName).toBe("Sami");
  });

  describe("an out-of-stock item, as each side sees it", () => {
    let unavailableOrderId: string;
    let unavailableItemId: string;

    beforeAll(async () => {
      const products = await http
        .get(`/api/shops/${merchantId}/products`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(200);
      const two = products.body.filter((p: { isAvailable: boolean }) => p.isAvailable).slice(0, 2);

      const order = await http
        .post("/api/orders")
        .set({ Authorization: `Bearer ${customerToken}` })
        .send({
          shopId: merchantId,
          items: two.map((p: { id: string }) => ({ productId: p.id, quantity: 1 })),
        })
        .expect(201);
      unavailableOrderId = order.body.id;

      await http
        .post(`/api/merchant/orders/${unavailableOrderId}/confirm`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(201);
      await http
        .post(`/api/merchant/orders/${unavailableOrderId}/start-preparing`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(201);

      const detail = await http
        .get(`/api/merchant/orders/${unavailableOrderId}`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(200);
      unavailableItemId = detail.body.items[0].id;

      // The shop cannot find one of the items.
      await http
        .patch(`/api/merchant/orders/${unavailableOrderId}/items/${unavailableItemId}`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ status: "UNAVAILABLE" })
        .expect(200);
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({ where: { orderId: unavailableOrderId } });
      await prisma.order.deleteMany({ where: { id: unavailableOrderId } });
    });

    it("BOTH sides mark the SAME item unavailable", async () => {
      // The handoff the founder called out: shop marks unavailable → customer
      // decides. If they disagreed about *which* item, the customer would be
      // accepting the removal of something else entirely.
      const c = (
        await http
          .get(`/api/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      const m = (
        await http
          .get(`/api/merchant/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${merchantToken}` })
          .expect(200)
      ).body;

      const mUnavailable = m.items.filter((i: { status: string }) => i.status === "UNAVAILABLE");
      expect(mUnavailable).toHaveLength(1);
      expect(c.hasUnavailableItems).toBe(true);
      expect(c.unavailableItemNames).toEqual([mUnavailable[0].name]);
    });

    it("BOTH sides agree the charged total has NOT changed yet", async () => {
      // The spec's rule: the total only moves when the customer accepts. If the
      // two sides disagreed here, one of them is quoting a price that is not
      // real.
      const c = (
        await http
          .get(`/api/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      const m = (
        await http
          .get(`/api/merchant/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${merchantToken}` })
          .expect(200)
      ).body;

      expect(m.totalPrice).toBe(c.totalPrice);
      // And both quote the same revised figure for after acceptance.
      expect(m.revisedTotal).toBe(c.revisedTotal);
      expect(c.revisedTotal).not.toBe(c.totalPrice);
    });

    it("after the customer accepts, BOTH sides move to the SAME new total", async () => {
      const before = (
        await http
          .get(`/api/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;

      await http
        .post(`/api/orders/${unavailableOrderId}/accept-changes`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(201);

      const c = (
        await http
          .get(`/api/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      const m = (
        await http
          .get(`/api/merchant/orders/${unavailableOrderId}`)
          .set({ Authorization: `Bearer ${merchantToken}` })
          .expect(200)
      ).body;

      expect(c.totalPrice).toBe(before.revisedTotal);
      expect(m.totalPrice).toBe(c.totalPrice);
    });
  });

  describe("a cancellation, as each side sees it", () => {
    let cancelledOrderId: string;

    beforeAll(async () => {
      const products = await http
        .get(`/api/shops/${merchantId}/products`)
        .set({ Authorization: `Bearer ${customerToken}` })
        .expect(200);
      const one = products.body.find((p: { isAvailable: boolean }) => p.isAvailable);

      const order = await http
        .post("/api/orders")
        .set({ Authorization: `Bearer ${customerToken}` })
        .send({ shopId: merchantId, items: [{ productId: one.id, quantity: 1 }] })
        .expect(201);
      cancelledOrderId = order.body.id;

      await http
        .post(`/api/merchant/orders/${cancelledOrderId}/confirm`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .expect(201);
      await http
        .post(`/api/merchant/orders/${cancelledOrderId}/cancel`)
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({ reason: "We are closing early today" })
        .expect(201);
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({ where: { orderId: cancelledOrderId } });
      await prisma.order.deleteMany({ where: { id: cancelledOrderId } });
    });

    it("all three agree it is CANCELLED, by the MERCHANT, for the SAME reason", async () => {
      // The shop's own words must reach the customer verbatim — and the admin
      // must see the same words when the customer complains about them.
      const c = (
        await http
          .get(`/api/orders/${cancelledOrderId}`)
          .set({ Authorization: `Bearer ${customerToken}` })
          .expect(200)
      ).body;
      const m = (
        await http
          .get(`/api/merchant/orders/${cancelledOrderId}`)
          .set({ Authorization: `Bearer ${merchantToken}` })
          .expect(200)
      ).body;
      const a = (
        await http
          .get("/api/admin/orders")
          .set({ Authorization: `Bearer ${adminToken}` })
          .expect(200)
      ).body.find((o: { id: string }) => o.id === cancelledOrderId);

      for (const view of [c, m, a]) {
        expect(view.status).toBe("CANCELLED");
        expect(view.cancelledBy).toBe("MERCHANT");
        expect(view.cancellationReason).toBe("We are closing early today");
      }
    });
  });
});
