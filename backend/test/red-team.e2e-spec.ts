import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, REAL_PNG, uniquePhone } from "./helpers";

/**
 * Cross-role attacks (8.3).
 *
 * This file does not read the code and conclude it looks safe. It signs in as
 * each role and **fires the malicious requests**, including at every endpoint
 * added in Phase 8 — the SSE stream, device registration, AI product entry, and
 * the admin escalation queue. New endpoints are where role checks get
 * forgotten, precisely because nobody has attacked them yet.
 *
 * Each test is named for the attack it attempts, so a failure reads as
 * "this attack now succeeds" rather than "assertion failed".
 */
describe("Cross-role attacks (8.3)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: TestAgent;

  let customerToken: string;
  let customerId: string;
  let merchantToken: string;
  let adminToken: string;

  /** A second, unrelated shop — the victim of the shop-isolation attacks. */
  let victimMerchantId: string;
  let victimProductId: string;
  let victimOrderId: string;

  /** The attacker merchant's own shop. */
  let attackerMerchantId: string;

  async function signIn(phone: string): Promise<{ token: string; userId: string }> {
    const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
    const verify = await http
      .post("/api/auth/otp/verify")
      .send({ phoneNumber: phone, code: req.body.devCode });
    return { token: verify.body.accessToken, userId: verify.body.user.id };
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = request(app.getHttpServer());

    const customer = await signIn("0791111111");
    customerToken = customer.token;
    customerId = customer.userId;

    merchantToken = (await signIn("0791234567")).token;
    adminToken = (await signIn("0799999999")).token;

    attackerMerchantId = (
      await prisma.merchant.findFirstOrThrow({
        where: { shopName: "Al-Nus Dinar Shop" },
        select: { id: true },
      })
    ).id;

    // Build a second shop with its own product and its own order, so the
    // isolation attacks have a real victim to aim at.
    const victimUser = await prisma.user.create({
      data: { phoneNumber: uniquePhone(), role: "MERCHANT", otpVerified: true },
      select: { id: true },
    });
    const victim = await prisma.merchant.create({
      data: {
        userId: victimUser.id,
        shopName: "[TEST] Victim Shop",
        locationLat: 31.95,
        locationLng: 35.91,
        openingHours: "08:00-23:00",
        status: "APPROVED",
        commissionRate: "0.10",
      },
      select: { id: true },
    });
    victimMerchantId = victim.id;

    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const product = await prisma.product.create({
      data: {
        merchantId: victimMerchantId,
        categoryId: category.id,
        name: "[TEST] Victim Product",
        price: "0.50",
        isAvailable: true,
      },
      select: { id: true },
    });
    victimProductId = product.id;

    const order = await prisma.order.create({
      data: {
        customerId,
        merchantId: victimMerchantId,
        status: "PENDING",
        totalPrice: "1.00",
        deliveryFee: "0.50",
        orderItems: { create: [{ productId: victimProductId, quantity: 1, priceAtOrder: "0.50" }] },
      },
      select: { id: true },
    });
    victimOrderId = order.id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { order: { merchantId: victimMerchantId } } });
    await prisma.order.deleteMany({ where: { merchantId: victimMerchantId } });
    await prisma.product.deleteMany({ where: { merchantId: victimMerchantId } });
    const victim = await prisma.merchant.findUnique({
      where: { id: victimMerchantId },
      select: { userId: true },
    });
    await prisma.merchant.deleteMany({ where: { id: victimMerchantId } });
    if (victim) await prisma.user.deleteMany({ where: { id: victim.userId } });
    await app.close();
  });

  // ── A customer reaching for merchant powers ───────────────────────────────

  describe("a CUSTOMER attacks the merchant surface", () => {
    const auth = () => ({ Authorization: `Bearer ${customerToken}` });

    it("cannot list a shop's orders", async () => {
      await http.get("/api/merchant/orders").set(auth()).expect(403);
    });

    it("cannot read the shop's new-order count", async () => {
      await http.get("/api/merchant/orders/pending-count").set(auth()).expect(403);
    });

    it("cannot subscribe to a shop's live order stream (Phase 8)", async () => {
      // New in Phase 8. An SSE endpoint is easy to forget when adding role
      // checks, and this one leaks every incoming order in real time.
      await http.get("/api/merchant/orders/stream").set(auth()).expect(403);
    });

    it("cannot confirm an order on the shop's behalf", async () => {
      await http.post(`/api/merchant/orders/${victimOrderId}/confirm`).set(auth()).expect(403);
    });

    it("cannot create a product", async () => {
      await http
        .post("/api/products")
        .set(auth())
        .send({ name: "Fake", price: 0.5, categoryId: "00000000-0000-4000-8000-000000000000" })
        .expect(403);
    });

    it("cannot list merchant products", async () => {
      await http.get("/api/products").set(auth()).expect(403);
    });

    it("cannot use AI product entry (Phase 8)", async () => {
      // New in Phase 8, and it costs money per call — an unauthenticated or
      // wrong-role caller would be running up the founder's AI bill.
      await http
        .post("/api/products/suggest-from-photo")
        .set(auth())
        .attach("file", REAL_PNG, "x.png")
        .expect(403);
    });

    it("cannot upload a product image", async () => {
      await http
        .post("/api/uploads/product-image")
        .set(auth())
        .attach("file", REAL_PNG, "x.png")
        .expect(403);
    });

    it("cannot read the merchant profile", async () => {
      await http.get("/api/merchants/me").set(auth()).expect(403);
    });
  });

  describe("a CUSTOMER attacks the admin surface", () => {
    const auth = () => ({ Authorization: `Bearer ${customerToken}` });

    it("cannot list every shop in the system", async () => {
      await http.get("/api/admin/merchants").set(auth()).expect(403);
    });

    it("cannot approve a shop", async () => {
      await http
        .patch(`/api/admin/merchants/${attackerMerchantId}/status`)
        .set(auth())
        .send({ status: "APPROVED" })
        .expect(403);
    });

    it("cannot read every order in the system", async () => {
      await http.get("/api/admin/orders").set(auth()).expect(403);
    });

    it("cannot read the escalation queue (Phase 8)", async () => {
      // Names other shops and exposes their phone numbers.
      await http.get("/api/admin/orders/ignored").set(auth()).expect(403);
    });

    it("cannot read platform stats", async () => {
      await http.get("/api/admin/stats").set(auth()).expect(403);
    });

    it("cannot create a master category", async () => {
      await http.post("/api/admin/categories").set(auth()).send({ name: "Hacked" }).expect(403);
    });
  });

  // ── A merchant reaching for admin powers ──────────────────────────────────

  describe("a MERCHANT attacks the admin surface", () => {
    const auth = () => ({ Authorization: `Bearer ${merchantToken}` });

    it("CANNOT APPROVE THEIR OWN SHOP — the whole point of approval", async () => {
      await http
        .patch(`/api/admin/merchants/${attackerMerchantId}/status`)
        .set(auth())
        .send({ status: "APPROVED" })
        .expect(403);
    });

    it("cannot suspend a competitor", async () => {
      await http
        .patch(`/api/admin/merchants/${victimMerchantId}/status`)
        .set(auth())
        .send({ status: "SUSPENDED" })
        .expect(403);
    });

    it("cannot read the escalation queue (Phase 8)", async () => {
      await http.get("/api/admin/orders/ignored").set(auth()).expect(403);
    });

    it("cannot read every order in the system", async () => {
      await http.get("/api/admin/orders").set(auth()).expect(403);
    });

    it("cannot invent a master category for everyone", async () => {
      await http.post("/api/admin/categories").set(auth()).send({ name: "Hacked" }).expect(403);
    });
  });

  describe("a MERCHANT attacks the customer surface", () => {
    const auth = () => ({ Authorization: `Bearer ${merchantToken}` });

    it("cannot place an order (against their own shop or anyone's)", async () => {
      await http
        .post("/api/orders")
        .set(auth())
        .send({ shopId: attackerMerchantId, items: [{ productId: victimProductId, quantity: 1 }] })
        .expect(403);
    });

    it("cannot read the customer order list", async () => {
      await http.get("/api/orders").set(auth()).expect(403);
    });

    it("cannot leave a review", async () => {
      await http
        .post(`/api/orders/${victimOrderId}/review`)
        .set(auth())
        .send({ rating: 5 })
        .expect(403);
    });
  });

  // ── Shop isolation: one merchant against another ──────────────────────────

  describe("a MERCHANT attacks ANOTHER SHOP's data", () => {
    const auth = () => ({ Authorization: `Bearer ${merchantToken}` });

    it("cannot read another shop's product, even with the exact id", async () => {
      // 404, not 403: a 403 would confirm the id exists, letting ids be probed.
      await http.get(`/api/products/${victimProductId}`).set(auth()).expect(404);
    });

    it("cannot edit another shop's product", async () => {
      await http
        .patch(`/api/products/${victimProductId}`)
        .set(auth())
        .send({ price: 99.99 })
        .expect(404);
    });

    it("cannot mark another shop's product out of stock", async () => {
      await http
        .patch(`/api/products/${victimProductId}/availability`)
        .set(auth())
        .send({ isAvailable: false })
        .expect(404);
    });

    it("cannot delete another shop's product", async () => {
      await http.delete(`/api/products/${victimProductId}`).set(auth()).expect(404);
    });

    it("cannot read another shop's order", async () => {
      await http.get(`/api/merchant/orders/${victimOrderId}`).set(auth()).expect(404);
    });

    it("cannot confirm another shop's order", async () => {
      await http.post(`/api/merchant/orders/${victimOrderId}/confirm`).set(auth()).expect(404);
    });

    it("cannot cancel another shop's order", async () => {
      await http
        .post(`/api/merchant/orders/${victimOrderId}/cancel`)
        .set(auth())
        .send({ reason: "sabotage" })
        .expect(404);
    });

    it("cannot assign a driver to another shop's order", async () => {
      await http
        .post(`/api/merchant/orders/${victimOrderId}/delivery`)
        .set(auth())
        .send({ captainName: "Mallory", captainPhone: "0791122334" })
        .expect(404);
    });

    it("its own order list contains ONLY its own orders", async () => {
      // The positive form of the same rule: isolation must hold on the read
      // path too, not just on the by-id lookups above.
      const res = await http.get("/api/merchant/orders").set(auth()).expect(200);
      const ids = res.body.map((o: { id: string }) => o.id);
      expect(ids).not.toContain(victimOrderId);
    });

    it("its own product list contains ONLY its own products", async () => {
      const res = await http.get("/api/products").set(auth()).expect(200);
      const ids = res.body.map((p: { id: string }) => p.id);
      expect(ids).not.toContain(victimProductId);
    });
  });

  // ── Harvesting phone numbers ──────────────────────────────────────────────

  describe("a MERCHANT harvests customer phone numbers outside the contact window", () => {
    const auth = () => ({ Authorization: `Bearer ${merchantToken}` });
    let deliveredOrderId: string;

    beforeAll(async () => {
      // A finished order: the shop has no live reason to contact this customer.
      const product = await prisma.product.findFirstOrThrow({
        where: { merchantId: attackerMerchantId },
        select: { id: true },
      });
      const order = await prisma.order.create({
        data: {
          customerId,
          merchantId: attackerMerchantId,
          status: "DELIVERED",
          totalPrice: "1.00",
          deliveryFee: "0.50",
          orderItems: { create: [{ productId: product.id, quantity: 1, priceAtOrder: "0.50" }] },
        },
        select: { id: true },
      });
      deliveredOrderId = order.id;
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({ where: { orderId: deliveredOrderId } });
      await prisma.order.deleteMany({ where: { id: deliveredOrderId } });
    });

    it("cannot read the number from a delivered order's DETAIL", async () => {
      // Found by the 8.3 audit: the dashboard hid the call button here, but the
      // API shipped the number anyway — the exact theatre Phase 7 rejected for
      // the customer's side of the same rule.
      const res = await http.get(`/api/merchant/orders/${deliveredOrderId}`).set(auth()).expect(200);
      expect(res.body.customer.phoneNumber).toBeNull();
    });

    it("cannot read the number from the order LIST", async () => {
      const res = await http.get("/api/merchant/orders").set(auth()).expect(200);
      const row = res.body.find((o: { id: string }) => o.id === deliveredOrderId);
      expect(row.customerPhone).toBeNull();
    });

    it("cannot harvest numbers in bulk from its whole order history", async () => {
      // The attack the per-order checks miss: one request, every customer.
      const res = await http.get("/api/merchant/orders").set(auth()).expect(200);
      const leaked = res.body.filter(
        (o: { status: string; customerPhone: string | null }) =>
          o.customerPhone !== null && !["CONFIRMED", "PREPARING"].includes(o.status),
      );
      expect(leaked).toEqual([]);
    });
  });

  // ── Customer against customer ─────────────────────────────────────────────

  describe("a CUSTOMER attacks ANOTHER CUSTOMER", () => {
    let otherCustomerToken: string;
    let otherCustomerId: string;

    beforeAll(async () => {
      const other = await signIn(uniquePhone().replace("+962", "0"));
      otherCustomerToken = other.token;
      otherCustomerId = other.userId;
    });

    afterAll(async () => {
      await prisma.deviceToken.deleteMany({ where: { userId: otherCustomerId } });
    });

    it("cannot read another customer's order, even with the exact id", async () => {
      await http
        .get(`/api/orders/${victimOrderId}`)
        .set({ Authorization: `Bearer ${otherCustomerToken}` })
        .expect(404);
    });

    it("cannot cancel another customer's order", async () => {
      await http
        .post(`/api/orders/${victimOrderId}/cancel`)
        .set({ Authorization: `Bearer ${otherCustomerToken}` })
        .send({})
        .expect(404);
    });

    it("cannot review another customer's order", async () => {
      await http
        .post(`/api/orders/${victimOrderId}/review`)
        .set({ Authorization: `Bearer ${otherCustomerToken}` })
        .send({ rating: 1, comment: "sabotage" })
        .expect(404);
    });

    it("cannot register a device against another customer's account (Phase 8)", async () => {
      // Would deliver a stranger's order notifications to the attacker's phone.
      await http
        .post("/api/auth/devices")
        .set({ Authorization: `Bearer ${otherCustomerToken}` })
        .send({
          token: "ExponentPushToken[attacker]",
          platform: "android",
          userId: customerId,
        })
        // Rejected outright, not silently ignored: whitelist +
        // forbidNonWhitelisted on the global ValidationPipe.
        .expect(400);
    });
  });

  // ── No token at all ───────────────────────────────────────────────────────

  describe("an ANONYMOUS caller attacks everything", () => {
    const protectedEndpoints: Array<[string, string]> = [
      ["get", "/api/auth/me"],
      ["get", "/api/shops"],
      ["get", "/api/orders"],
      ["get", "/api/products"],
      ["get", "/api/categories"],
      ["get", "/api/merchants/me"],
      ["get", "/api/merchant/orders"],
      ["get", "/api/merchant/orders/pending-count"],
      ["get", "/api/merchant/orders/stream"],
      ["get", "/api/admin/merchants"],
      ["get", "/api/admin/orders"],
      ["get", "/api/admin/orders/ignored"],
      ["get", "/api/admin/stats"],
      ["get", "/api/admin/categories"],
    ];

    it.each(protectedEndpoints)("refuses %s %s without a token", async (method, path) => {
      const res = await (http as unknown as Record<string, (p: string) => request.Test>)[method](
        path,
      );
      expect(res.status).toBe(401);
    });

    it("refuses a forged token", async () => {
      await http
        .get("/api/auth/me")
        .set({ Authorization: "Bearer not.a.real.token" })
        .expect(401);
    });

    it("refuses a token signed with the wrong secret", async () => {
      // A hand-rolled JWT with a plausible payload but a bogus signature.
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ sub: customerId, role: "ADMIN", exp: 9999999999 }),
      ).toString("base64url");
      await http
        .get("/api/admin/stats")
        .set({ Authorization: `Bearer ${header}.${payload}.forgedsignature` })
        .expect(401);
    });
  });

  // ── Privilege escalation via the token's own claims ───────────────────────

  describe("privilege escalation attempts", () => {
    it("a role change takes effect IMMEDIATELY on an existing token", async () => {
      // JwtStrategy re-reads the user on every request rather than trusting the
      // token's claims — so a token minted while someone was an admin stops
      // working the moment they are demoted. Proven by demoting and retrying.
      const victim = await signIn(uniquePhone().replace("+962", "0"));

      await prisma.user.update({ where: { id: victim.userId }, data: { role: "ADMIN" } });
      await http
        .get("/api/admin/stats")
        .set({ Authorization: `Bearer ${victim.token}` })
        .expect(200);

      // Same token, role revoked.
      await prisma.user.update({ where: { id: victim.userId }, data: { role: "CUSTOMER" } });
      await http
        .get("/api/admin/stats")
        .set({ Authorization: `Bearer ${victim.token}` })
        .expect(403);

      await prisma.user.deleteMany({ where: { id: victim.userId } });
    });

    it("a deleted account's token stops working immediately", async () => {
      const victim = await signIn(uniquePhone().replace("+962", "0"));
      await http.get("/api/auth/me").set({ Authorization: `Bearer ${victim.token}` }).expect(200);

      await prisma.user.delete({ where: { id: victim.userId } });

      await http.get("/api/auth/me").set({ Authorization: `Bearer ${victim.token}` }).expect(401);
    });

    it("cannot smuggle a merchantId into a product to write to another shop", async () => {
      const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
      await http
        .post("/api/products")
        .set({ Authorization: `Bearer ${merchantToken}` })
        .send({
          name: "[TEST] Smuggled",
          price: 0.5,
          categoryId: category.id,
          merchantId: victimMerchantId,
        })
        // Rejected, not ignored — an ignored field would be a silent near-miss.
        .expect(400);
    });
  });
});
