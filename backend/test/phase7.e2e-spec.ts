/**
 * Phase 7 — direct contact, reviews, and the admin panel.
 *
 * The contact rules are enforced on the SERVER: outside its window a phone
 * number is absent from the response entirely, not merely hidden by the app.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
// `request(app)` returns TestAgent; ReturnType keeps this correct across
// supertest versions rather than naming a type that has since changed.
let http: () => ReturnType<typeof request>;

const createdPhones: string[] = [];
const createdCategoryIds: string[] = [];

let pilotShopId: string;
let merchantAuth: { Authorization: string };
let adminAuth: { Authorization: string };
let chocolateId: string;

const MERCHANT_PHONE_E164 = "+962791234567";
const CAPTAIN = { captainName: "Omar Al-Zoubi", captainPhone: "0791122334" };
const CAPTAIN_PHONE_E164 = "+962791122334";

async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

async function newCustomer() {
  const phoneNumber = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phoneNumber);
  return { Authorization: `Bearer ${await login(phoneNumber)}` };
}

async function placeOrder(customer: { Authorization: string }) {
  return (
    await http()
      .post("/api/orders")
      .set(customer)
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 1 }] })
      .expect(201)
  ).body;
}

/** Drives an order all the way to DELIVERED through the real endpoints. */
async function deliverOrder(customer: { Authorization: string }) {
  const order = await placeOrder(customer);
  await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
  await http().post(`/api/merchant/orders/${order.id}/start-preparing`).set(merchantAuth).expect(201);
  await http().post(`/api/merchant/orders/${order.id}/delivery`).set(merchantAuth).send(CAPTAIN).expect(201);
  await http()
    .patch(`/api/merchant/orders/${order.id}/delivery`)
    .set(merchantAuth)
    .send({ status: "PICKED_UP" })
    .expect(200);
  await http()
    .patch(`/api/merchant/orders/${order.id}/delivery`)
    .set(merchantAuth)
    .send({ status: "DELIVERED" })
    .expect(200);
  return order;
}

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  merchantAuth = { Authorization: `Bearer ${await login(MERCHANT_PHONE_E164)}` };
  adminAuth = { Authorization: `Bearer ${await login("+962799999999")}` };

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;

  chocolateId = (
    await prisma.product.findFirstOrThrow({
      where: { name: "Chocolate Bar 30g", merchantId: pilotShopId },
    })
  ).id;
});

afterAll(async () => {
  const testCustomers = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: "+962780000" } },
    select: { id: true },
  });
  await prisma.order.deleteMany({ where: { customerId: { in: testCustomers.map((c) => c.id) } } });
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await app.close();
});

describe("Direct contact is exposed only inside its window", () => {
  it("does not give out the shop's number while the order is merely pending", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    // Not "hidden by the app" — absent from the response.
    expect(seen.body.contact.shopPhone).toBeNull();
    expect(JSON.stringify(seen.body)).not.toContain(MERCHANT_PHONE_E164);
  });

  it("gives out the shop's number while they are preparing the order", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);

    const confirmed = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(confirmed.body.contact.shopPhone).toBe(MERCHANT_PHONE_E164);

    await http().post(`/api/merchant/orders/${order.id}/start-preparing`).set(merchantAuth).expect(201);

    const preparing = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(preparing.body.contact.shopPhone).toBe(MERCHANT_PHONE_E164);
  });

  it("stops giving out the shop's number once the order is delivered", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.contact.shopPhone).toBeNull();
    expect(JSON.stringify(seen.body)).not.toContain(MERCHANT_PHONE_E164);
  });

  it("does not give out the driver's number before they collect the order", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/start-preparing`).set(merchantAuth).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/delivery`).set(merchantAuth).send(CAPTAIN).expect(201);

    // Assigned only — not yet carrying it.
    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.contact.driverPhone).toBeNull();
  });

  it("gives out the driver's number while the order is on its way", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/start-preparing`).set(merchantAuth).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/delivery`).set(merchantAuth).send(CAPTAIN).expect(201);
    await http()
      .patch(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ status: "PICKED_UP" })
      .expect(200);
    await http()
      .patch(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ status: "ON_WAY" })
      .expect(200);

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.contact.driverPhone).toBe(CAPTAIN_PHONE_E164);
    expect(seen.body.contact.driverName).toBe("Omar Al-Zoubi");
    // The shop is no longer the right person to call.
    expect(seen.body.contact.shopPhone).toBeNull();
  });

  it("stops giving out the driver's number once delivered", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.contact.driverPhone).toBeNull();
  });
});

describe("Reviews", () => {
  it("accepts a rating and comment after delivery", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    const before = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(before.body.canReview).toBe(true);

    const reviewed = await http()
      .post(`/api/orders/${order.id}/review`)
      .set(customer)
      .send({ rating: 5, comment: "Fast and friendly" })
      .expect(201);

    expect(reviewed.body.review.rating).toBe(5);
    expect(reviewed.body.review.comment).toBe("Fast and friendly");
    expect(reviewed.body.canReview).toBe(false);

    const row = await prisma.review.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.rating).toBe(5);
  });

  it("accepts a rating with no comment", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    const reviewed = await http()
      .post(`/api/orders/${order.id}/review`)
      .set(customer)
      .send({ rating: 4 })
      .expect(201);

    expect(reviewed.body.review.rating).toBe(4);
    expect(reviewed.body.review.comment).toBeNull();
  });

  it("refuses a review before the order is delivered", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);

    const res = await http()
      .post(`/api/orders/${order.id}/review`)
      .set(customer)
      .send({ rating: 5 });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/delivered/i);
  });

  it("refuses a second review for the same order", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    await http().post(`/api/orders/${order.id}/review`).set(customer).send({ rating: 5 }).expect(201);
    await http().post(`/api/orders/${order.id}/review`).set(customer).send({ rating: 1 }).expect(409);

    // Still the original.
    const row = await prisma.review.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.rating).toBe(5);
  });

  it("refuses a rating outside 1..5", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);

    for (const rating of [0, 6, -2]) {
      await http().post(`/api/orders/${order.id}/review`).set(customer).send({ rating }).expect(400);
    }
  });

  it("refuses to review someone else's order", async () => {
    const customer = await newCustomer();
    const order = await deliverOrder(customer);
    const stranger = await newCustomer();

    await http().post(`/api/orders/${order.id}/review`).set(stranger).send({ rating: 1 }).expect(404);
  });
});

describe("Admin: merchant approval", () => {
  it("lists shops of every status, including pending ones", async () => {
    const res = await http().get("/api/admin/merchants").set(adminAuth).expect(200);
    expect(res.body.some((m: { shopName: string }) => m.shopName === "Al-Nus Dinar Shop")).toBe(true);
  });

  it("approves a pending shop, which makes it visible to customers", async () => {
    // A brand-new pending shop.
    const phoneNumber = `+96277${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    createdPhones.push(phoneNumber);
    await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber,
        shopName: "[TEST] Approval Queue Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(201);

    const pending = await http().get("/api/admin/merchants?status=PENDING").set(adminAuth).expect(200);
    const shop = pending.body.find((m: { shopName: string }) => m.shopName === "[TEST] Approval Queue Shop");
    expect(shop).toBeDefined();

    // Invisible to customers while pending.
    const customer = await newCustomer();
    const before = await http().get("/api/shops").set(customer).expect(200);
    expect(before.body.map((s: { id: string }) => s.id)).not.toContain(shop.id);

    // Admin approves.
    const approved = await http()
      .patch(`/api/admin/merchants/${shop.id}/status`)
      .set(adminAuth)
      .send({ status: "APPROVED" })
      .expect(200);
    expect(approved.body.status).toBe("APPROVED");

    // Now visible.
    const after = await http().get("/api/shops").set(customer).expect(200);
    expect(after.body.map((s: { id: string }) => s.id)).toContain(shop.id);
  });

  it("suspends a shop, which hides it from customers again", async () => {
    const customer = await newCustomer();

    await http()
      .patch(`/api/admin/merchants/${pilotShopId}/status`)
      .set(adminAuth)
      .send({ status: "SUSPENDED" })
      .expect(200);

    try {
      const shops = await http().get("/api/shops").set(customer).expect(200);
      expect(shops.body.map((s: { id: string }) => s.id)).not.toContain(pilotShopId);
      await http().get(`/api/shops/${pilotShopId}`).set(customer).expect(404);
    } finally {
      await http()
        .patch(`/api/admin/merchants/${pilotShopId}/status`)
        .set(adminAuth)
        .send({ status: "APPROVED" })
        .expect(200);
    }
  });

  it("refuses to set a status the shop already has", async () => {
    await http()
      .patch(`/api/admin/merchants/${pilotShopId}/status`)
      .set(adminAuth)
      .send({ status: "APPROVED" })
      .expect(409);
  });

  it("rejects an invalid status", async () => {
    await http()
      .patch(`/api/admin/merchants/${pilotShopId}/status`)
      .set(adminAuth)
      .send({ status: "BANISHED" })
      .expect(400);
  });
});

describe("Admin: master categories", () => {
  it("creates a root category and a subcategory under it", async () => {
    const root = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Test Root" })
      .expect(201);
    createdCategoryIds.push(root.body.id);
    expect(root.body.path).toBe("ZZ Test Root");

    const child = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Test Child", parentCategoryId: root.body.id })
      .expect(201);
    createdCategoryIds.push(child.body.id);
    expect(child.body.path).toBe("ZZ Test Root > ZZ Test Child");
  });

  it("stops two root categories sharing a name", async () => {
    const first = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Duplicate Root" })
      .expect(201);
    createdCategoryIds.push(first.body.id);

    // PostgreSQL's unique index treats NULL parents as distinct, so this is
    // guarded in the service — see CLAUDE.md "Known nuance".
    await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Duplicate Root" })
      .expect(409);
  });

  it("refuses to nest categories more than one level deep", async () => {
    const root = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Deep Root" })
      .expect(201);
    createdCategoryIds.push(root.body.id);

    const child = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Deep Child", parentCategoryId: root.body.id })
      .expect(201);
    createdCategoryIds.push(child.body.id);

    await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Too Deep", parentCategoryId: child.body.id })
      .expect(400);
  });

  it("renames a category", async () => {
    const created = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Rename Me" })
      .expect(201);
    createdCategoryIds.push(created.body.id);

    const renamed = await http()
      .patch(`/api/admin/categories/${created.body.id}`)
      .set(adminAuth)
      .send({ name: "ZZ Renamed" })
      .expect(200);

    expect(renamed.body.name).toBe("ZZ Renamed");
  });

  it("deletes an empty category", async () => {
    const created = await http()
      .post("/api/admin/categories")
      .set(adminAuth)
      .send({ name: "ZZ Delete Me" })
      .expect(201);

    await http().delete(`/api/admin/categories/${created.body.id}`).set(adminAuth).expect(200);

    const all = await http().get("/api/admin/categories").set(adminAuth).expect(200);
    expect(all.body.map((c: { id: string }) => c.id)).not.toContain(created.body.id);
  });

  it("refuses to delete a category that still has products", async () => {
    const all = await http().get("/api/admin/categories").set(adminAuth).expect(200);
    const drinks = all.body.find((c: { name: string }) => c.name === "Drinks");

    const res = await http().delete(`/api/admin/categories/${drinks.id}`).set(adminAuth);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/product/i);
  });

  it("refuses to delete a category that still has subcategories", async () => {
    const all = await http().get("/api/admin/categories").set(adminAuth).expect(200);
    const household = all.body.find((c: { name: string }) => c.name === "Household");

    const res = await http().delete(`/api/admin/categories/${household.id}`).set(adminAuth);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/subcategor/i);
  });
});

describe("Admin: oversight", () => {
  it("sees orders across all shops, with cancellations and reasons", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer);
    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({ reason: "Test cancel" }).expect(201);

    const cancelled = await http().get("/api/admin/orders?cancelledOnly=true").set(adminAuth).expect(200);
    const mine = cancelled.body.find((o: { id: string }) => o.id === order.id);

    expect(mine).toBeDefined();
    expect(mine.cancelledBy).toBe("CUSTOMER");
    expect(mine.cancellationReason).toBe("Test cancel");
    expect(mine.shopName).toBe("Al-Nus Dinar Shop");
  });

  it("reports headline stats", async () => {
    const res = await http().get("/api/admin/stats").set(adminAuth).expect(200);

    expect(res.body).toHaveProperty("pendingMerchants");
    expect(res.body).toHaveProperty("approvedMerchants");
    expect(res.body).toHaveProperty("totalOrders");
    expect(res.body).toHaveProperty("cancelledOrders");
    expect(typeof res.body.approvedMerchants).toBe("number");
  });
});

describe("Admin access control", () => {
  it("blocks a customer from every admin endpoint", async () => {
    const customer = await newCustomer();

    await http().get("/api/admin/merchants").set(customer).expect(403);
    await http().get("/api/admin/orders").set(customer).expect(403);
    await http().get("/api/admin/stats").set(customer).expect(403);
    await http().post("/api/admin/categories").set(customer).send({ name: "Sneaky" }).expect(403);
    await http()
      .patch(`/api/admin/merchants/${pilotShopId}/status`)
      .set(customer)
      .send({ status: "SUSPENDED" })
      .expect(403);
  });

  it("blocks a MERCHANT from approving their own shop", async () => {
    // The whole point of approval: a shop must not be able to approve itself.
    await http()
      .patch(`/api/admin/merchants/${pilotShopId}/status`)
      .set(merchantAuth)
      .send({ status: "APPROVED" })
      .expect(403);

    await http().get("/api/admin/merchants").set(merchantAuth).expect(403);
    await http().post("/api/admin/categories").set(merchantAuth).send({ name: "Mine" }).expect(403);
  });

  it("requires a token", async () => {
    await http().get("/api/admin/merchants").expect(401);
    await http().get("/api/admin/stats").expect(401);
  });
});
