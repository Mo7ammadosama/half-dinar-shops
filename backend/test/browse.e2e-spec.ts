/**
 * Phase 3 customer-browsing e2e tests.
 *
 * The central rule under test: **a customer may only ever see APPROVED shops.**
 * A shop that is pending or suspended must be completely invisible — not listed,
 * not readable by id, and its products unreachable even when the id is known.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, uniquePhone } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
// `request(app)` returns TestAgent; ReturnType keeps this correct across
// supertest versions rather than naming a type that has since changed.
let http: () => ReturnType<typeof request>;

const createdPhones: string[] = [];

/** The seeded, approved pilot shop. */
let pilotShopId: string;
/** Token for the seeded customer. */
let customerAuth: { Authorization: string };

/** Signs in any phone number and returns the token. */
async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

/**
 * Creates a shop in a given status, with one product, by writing directly to the
 * database — the API deliberately offers no way to self-approve.
 */
async function createShopWithProduct(status: "PENDING" | "APPROVED" | "SUSPENDED", label: string) {
  const phoneNumber = uniquePhone();
  createdPhones.push(phoneNumber);

  const category = await prisma.category.findFirstOrThrow({ select: { id: true } });

  const user = await prisma.user.create({
    data: { phoneNumber, role: "MERCHANT", otpVerified: true },
    select: { id: true },
  });

  const merchant = await prisma.merchant.create({
    data: {
      userId: user.id,
      shopName: `[TEST] ${label}`,
      locationLat: 31.95,
      locationLng: 35.93,
      openingHours: "08:00-23:00",
      status,
    },
    select: { id: true },
  });

  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      categoryId: category.id,
      name: `${label} Secret Product`,
      price: "0.50",
    },
    select: { id: true },
  });

  return { merchantId: merchant.id, productId: product.id, phoneNumber };
}

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  customerAuth = { Authorization: `Bearer ${await login("+962791111111")}` };

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await app.close();
});

describe("Browsing requires a signed-in user", () => {
  it("refuses every browse endpoint without a token", async () => {
    await http().get("/api/shops").expect(401);
    await http().get(`/api/shops/${pilotShopId}`).expect(401);
    await http().get(`/api/shops/${pilotShopId}/products`).expect(401);
    await http().get(`/api/shops/${pilotShopId}/categories`).expect(401);
  });
});

describe("Customers only ever see APPROVED shops", () => {
  it("lists the approved pilot shop", async () => {
    const res = await http().get("/api/shops").set(customerAuth).expect(200);

    const names = res.body.map((s: { shopName: string }) => s.shopName);
    expect(names).toContain("Al-Nus Dinar Shop");
  });

  it("hides a PENDING shop from the list, by id, and its products", async () => {
    const pending = await createShopWithProduct("PENDING", "Pending Shop");

    const list = await http().get("/api/shops").set(customerAuth).expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).not.toContain(pending.merchantId);
    expect(JSON.stringify(list.body)).not.toContain("Pending Shop");

    // Knowing the exact id must not help.
    await http().get(`/api/shops/${pending.merchantId}`).set(customerAuth).expect(404);
    await http().get(`/api/shops/${pending.merchantId}/products`).set(customerAuth).expect(404);
    await http().get(`/api/shops/${pending.merchantId}/categories`).set(customerAuth).expect(404);
  });

  it("hides a SUSPENDED shop just as completely", async () => {
    const suspended = await createShopWithProduct("SUSPENDED", "Suspended Shop");

    const list = await http().get("/api/shops").set(customerAuth).expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).not.toContain(suspended.merchantId);

    await http().get(`/api/shops/${suspended.merchantId}`).set(customerAuth).expect(404);
    await http().get(`/api/shops/${suspended.merchantId}/products`).set(customerAuth).expect(404);
  });

  it("makes a shop visible the moment it is approved, and invisible again when suspended", async () => {
    const shop = await createShopWithProduct("PENDING", "Approval Lifecycle Shop");

    // Invisible while pending.
    await http().get(`/api/shops/${shop.merchantId}`).set(customerAuth).expect(404);

    // Approved -> visible, with its product.
    await prisma.merchant.update({
      where: { id: shop.merchantId },
      data: { status: "APPROVED" },
    });
    await http().get(`/api/shops/${shop.merchantId}`).set(customerAuth).expect(200);
    const products = await http()
      .get(`/api/shops/${shop.merchantId}/products`)
      .set(customerAuth)
      .expect(200);
    expect(products.body).toHaveLength(1);

    // Suspended -> invisible again. This proves the rule is evaluated per
    // request, not captured once at creation.
    await prisma.merchant.update({
      where: { id: shop.merchantId },
      data: { status: "SUSPENDED" },
    });
    await http().get(`/api/shops/${shop.merchantId}`).set(customerAuth).expect(404);
    await http().get(`/api/shops/${shop.merchantId}/products`).set(customerAuth).expect(404);
  });

  it("does not leak an unapproved shop's products through another shop's id", async () => {
    const pending = await createShopWithProduct("PENDING", "Leak Test Shop");

    // Browsing the *approved* pilot shop must never surface the pending shop's stock.
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products`)
      .set(customerAuth)
      .expect(200);

    expect(JSON.stringify(res.body)).not.toContain("Leak Test Shop Secret Product");
    expect(res.body.every((p: { id: string }) => p.id !== pending.productId)).toBe(true);
  });
});

describe("Browsing the pilot shop", () => {
  it("returns all 20 seeded products with correct price, category and availability", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products`)
      .set(customerAuth)
      .expect(200);

    expect(res.body).toHaveLength(20);

    const chocolate = res.body.find((p: { name: string }) => p.name === "Chocolate Bar 30g");
    expect(chocolate).toBeDefined();
    expect(chocolate.price).toBe("0.50");
    expect(chocolate.categoryPath).toBe("Food & Snacks > Biscuits & Sweets");
    expect(chocolate.isAvailable).toBe(true);
  });

  it("shows out-of-stock items rather than hiding them, marked unavailable", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products`)
      .set(customerAuth)
      .expect(200);

    const energy = res.body.find((p: { name: string }) => p.name === "Energy Drink 250ml");
    expect(energy).toBeDefined();
    expect(energy.isAvailable).toBe(false);
  });

  it("sorts available products ahead of out-of-stock ones", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products`)
      .set(customerAuth)
      .expect(200);

    const firstUnavailable = res.body.findIndex((p: { isAvailable: boolean }) => !p.isAvailable);
    const lastAvailable = res.body.map((p: { isAvailable: boolean }) => p.isAvailable).lastIndexOf(true);
    expect(firstUnavailable).toBeGreaterThan(lastAvailable);
  });

  it("prices never arrive as floats", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products`)
      .set(customerAuth)
      .expect(200);

    for (const p of res.body) {
      expect(typeof p.price).toBe("string");
      expect(p.price).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("filters by search term", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products?search=juice`)
      .set(customerAuth)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Orange Juice Box 250ml");
  });

  it("search is case-insensitive", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products?search=CHOCOLATE`)
      .set(customerAuth)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Chocolate Bar 30g");
  });

  it("filters by category", async () => {
    const drinks = await prisma.category.findFirstOrThrow({
      where: { name: "Drinks" },
      select: { id: true },
    });

    const res = await http()
      .get(`/api/shops/${pilotShopId}/products?categoryId=${drinks.id}`)
      .set(customerAuth)
      .expect(200);

    expect(res.body).toHaveLength(3);
    for (const p of res.body) {
      expect(p.categoryPath).toBe("Food & Snacks > Drinks");
    }
  });

  it("returns an empty list (not an error) when nothing matches", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/products?search=zzzznothing`)
      .set(customerAuth)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it("lists only the categories the shop actually stocks", async () => {
    const res = await http()
      .get(`/api/shops/${pilotShopId}/categories`)
      .set(customerAuth)
      .expect(200);

    // The seed places products in 6 of the 8 master categories.
    const paths = res.body.map((c: { path: string }) => c.path);
    expect(paths).toContain("Food & Snacks > Drinks");
    expect(paths).toContain("Stationery");

    // Empty parent categories must not appear as dead-end filters.
    expect(paths).not.toContain("Household");
    expect(paths).not.toContain("Food & Snacks");

    for (const c of res.body) {
      expect(c.productCount).toBeGreaterThan(0);
    }
  });

  it("rejects a malformed shop id", async () => {
    await http().get("/api/shops/not-a-uuid/products").set(customerAuth).expect(400);
  });

  it("404s for a shop id that does not exist at all", async () => {
    // A syntactically valid v4 UUID that exists in no table, so this reaches the
    // lookup rather than being rejected as malformed (which would be a 400 and
    // would make this test pass without proving anything).
    await http()
      .get("/api/shops/11111111-1111-4111-8111-111111111111/products")
      .set(customerAuth)
      .expect(404);
  });
});
