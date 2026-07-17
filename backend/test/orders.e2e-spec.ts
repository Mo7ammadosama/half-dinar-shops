/**
 * Phase 4 order-placement e2e tests.
 *
 * The rules under test:
 *   - Prices come from the DATABASE, never the client.
 *   - `price_at_order` is an immutable snapshot.
 *   - Only APPROVED shops can be ordered from.
 *   - A customer can only ever see their own orders.
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
const createdOrderIds: string[] = [];

/**
 * A syntactically valid v4 UUID that exists in no table.
 *
 * NOT the all-zeros UUID: that fails v4 format validation and returns 400, so a
 * test using it would pass without ever reaching the "does this exist?" check —
 * green for the wrong reason.
 */
const NONEXISTENT_UUID = "11111111-1111-4111-8111-111111111111";

let pilotShopId: string;
let customerAuth: { Authorization: string };
let customerId: string;

/** Seeded products, resolved once. */
let chocolateId: string; // 0.50
let foilId: string; // 0.90
let energyDrinkId: string; // 0.75, OUT OF STOCK

async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

/** Signs in a fresh customer from the reserved test range. */
async function newCustomer() {
  const phoneNumber = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phoneNumber);
  const token = await login(phoneNumber);
  return { phoneNumber, auth: { Authorization: `Bearer ${token}` } };
}

/** Places an order and tracks it for cleanup. */
async function placeOrder(auth: { Authorization: string }, items: Array<{ productId: string; quantity: number }>) {
  const res = await http().post("/api/orders").set(auth).send({ shopId: pilotShopId, items });
  if (res.status === 201) createdOrderIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  const token = await login("+962791111111");
  customerAuth = { Authorization: `Bearer ${token}` };
  const me = await http().get("/api/auth/me").set(customerAuth).expect(200);
  customerId = me.body.id;

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;

  const find = async (name: string) =>
    (await prisma.product.findFirstOrThrow({ where: { name, merchantId: pilotShopId } })).id;

  chocolateId = await find("Chocolate Bar 30g");
  foilId = await find("Aluminium Foil Roll");
  energyDrinkId = await find("Energy Drink 250ml");
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await app.close();
});

describe("Placing an order", () => {
  it("stores the order with items, snapshotted prices and a correct total", async () => {
    // 2 x Chocolate (0.50) + 1 x Foil (0.90) = 1.90, + 0.50 delivery = 2.40
    const res = await placeOrder(customerAuth, [
      { productId: chocolateId, quantity: 2 },
      { productId: foilId, quantity: 1 },
    ]);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.paymentMethod).toBe("cash_on_delivery");
    expect(res.body.itemsTotal).toBe("1.90");
    expect(res.body.deliveryFee).toBe("0.50");
    expect(res.body.totalPrice).toBe("2.40");
    expect(res.body.items).toHaveLength(2);

    // And it is really in the database, not just in the response.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { orderItems: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.totalPrice.toFixed(2)).toBe("2.40");
    expect(row.deliveryFee.toFixed(2)).toBe("0.50");
    expect(row.orderItems).toHaveLength(2);

    const chocolateLine = row.orderItems.find((i) => i.productId === chocolateId)!;
    expect(chocolateLine.quantity).toBe(2);
    expect(chocolateLine.priceAtOrder.toFixed(2)).toBe("0.50");
    expect(chocolateLine.status).toBe("CONFIRMED");
  });

  it("adds up many half-dinar items exactly, with no floating-point drift", async () => {
    // 7 x 0.50 = 3.50 exactly. Floats would risk 3.4999999999999996.
    const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 7 }]);

    expect(res.status).toBe(201);
    expect(res.body.itemsTotal).toBe("3.50");
    expect(res.body.totalPrice).toBe("4.00");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.totalPrice.toFixed(2)).toBe("4.00");
  });

  it("records who placed the order and against which shop", async () => {
    const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1 }]);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.customerId).toBe(customerId);
    expect(row.merchantId).toBe(pilotShopId);
  });
});

describe("Prices cannot be manipulated by the client", () => {
  it("ignores a price sent by the client instead of trusting it", async () => {
    // The DTO has no price field, so ValidationPipe's forbidNonWhitelisted
    // rejects the attempt outright rather than silently ignoring it.
    const res = await http()
      .post("/api/orders")
      .set(customerAuth)
      .send({
        shopId: pilotShopId,
        items: [{ productId: chocolateId, quantity: 1, price: 0.01, priceAtOrder: 0.01 }],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/should not exist/);
  });

  it("ignores a total sent by the client", async () => {
    const res = await http()
      .post("/api/orders")
      .set(customerAuth)
      .send({
        shopId: pilotShopId,
        items: [{ productId: chocolateId, quantity: 1 }],
        totalPrice: "0.01",
        deliveryFee: "0.00",
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/should not exist/);
  });

  it("snapshots the price at order time and never revalues it afterwards", async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: chocolateId } });
    expect(before.price.toFixed(2)).toBe("0.50");

    const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 2 }]);
    expect(res.body.totalPrice).toBe("1.50"); // 1.00 + 0.50 delivery

    // The merchant reprices the product afterwards.
    await prisma.product.update({ where: { id: chocolateId }, data: { price: "9.99" } });

    try {
      // Re-reading the order must still show the old price and old total.
      const reread = await http().get(`/api/orders/${res.body.id}`).set(customerAuth).expect(200);
      expect(reread.body.items[0].priceAtOrder).toBe("0.50");
      expect(reread.body.items[0].lineTotal).toBe("1.00");
      expect(reread.body.totalPrice).toBe("1.50");

      const row = await prisma.orderItem.findFirstOrThrow({ where: { orderId: res.body.id } });
      expect(row.priceAtOrder.toFixed(2)).toBe("0.50");
    } finally {
      // Restore so the suite stays re-runnable.
      await prisma.product.update({ where: { id: chocolateId }, data: { price: before.price } });
    }
  });

  it("charges the price at the moment of ordering, not the old one", async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: chocolateId } });

    await prisma.product.update({ where: { id: chocolateId }, data: { price: "0.80" } });
    try {
      const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1 }]);
      // Snapshot must be the CURRENT price (0.80), proving it is read live.
      expect(res.body.items[0].priceAtOrder).toBe("0.80");
      expect(res.body.totalPrice).toBe("1.30");
    } finally {
      await prisma.product.update({ where: { id: chocolateId }, data: { price: before.price } });
    }
  });
});

describe("Order validation", () => {
  it("refuses an empty order", async () => {
    const res = await http()
      .post("/api/orders")
      .set(customerAuth)
      .send({ shopId: pilotShopId, items: [] });
    expect(res.status).toBe(400);
  });

  it("refuses a zero or negative quantity", async () => {
    for (const quantity of [0, -3]) {
      const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity }]);
      expect(res.status).toBe(400);
    }
  });

  it("refuses a fractional quantity", async () => {
    const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1.5 }]);
    expect(res.status).toBe(400);
  });

  it("refuses an out-of-stock item, naming it", async () => {
    const res = await placeOrder(customerAuth, [{ productId: energyDrinkId, quantity: 1 }]);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Energy Drink 250ml");
  });

  it("refuses a product that belongs to a different shop", async () => {
    // A second shop with its own product.
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const otherUser = await prisma.user.create({
      data: { phoneNumber, role: "MERCHANT", otpVerified: true },
      select: { id: true },
    });
    const otherShop = await prisma.merchant.create({
      data: {
        userId: otherUser.id,
        shopName: "[TEST] Other Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
        status: "APPROVED",
      },
      select: { id: true },
    });
    const otherProduct = await prisma.product.create({
      data: { merchantId: otherShop.id, categoryId: category.id, name: "Other Item", price: "0.50" },
      select: { id: true },
    });

    // Ordering another shop's product against the pilot shop must fail.
    const res = await placeOrder(customerAuth, [{ productId: otherProduct.id, quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not sold by this shop/);
  });

  it("refuses a product that does not exist", async () => {
    const res = await placeOrder(customerAuth, [{ productId: NONEXISTENT_UUID, quantity: 1 }]);

    expect(res.status).toBe(400);
    // Must be rejected for not existing, not merely for being malformed.
    expect(res.body.message).toMatch(/not sold by this shop/);
  });

  it("rejects a malformed product id", async () => {
    const res = await placeOrder(customerAuth, [
      { productId: "not-a-uuid", quantity: 1 } as unknown as { productId: string; quantity: number },
    ]);
    expect(res.status).toBe(400);
  });

  it("refuses duplicate lines rather than guessing intent", async () => {
    const res = await placeOrder(customerAuth, [
      { productId: chocolateId, quantity: 1 },
      { productId: chocolateId, quantity: 2 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than once/);
  });

  it("writes nothing when an order is rejected", async () => {
    const before = await prisma.order.count();

    await placeOrder(customerAuth, [
      { productId: chocolateId, quantity: 1 },
      { productId: energyDrinkId, quantity: 1 }, // out of stock -> whole order fails
    ]);

    // The transaction must leave no partial order behind.
    expect(await prisma.order.count()).toBe(before);
  });
});

describe("Ordering respects the approved-only rule", () => {
  it("refuses to order from a shop that is not approved", async () => {
    await prisma.merchant.update({ where: { id: pilotShopId }, data: { status: "SUSPENDED" } });
    try {
      const res = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1 }]);
      // 404, not 403 — the shop must look like it does not exist.
      expect(res.status).toBe(404);
    } finally {
      await prisma.merchant.update({ where: { id: pilotShopId }, data: { status: "APPROVED" } });
    }
  });

  it("refuses a shop id that does not exist", async () => {
    const res = await http()
      .post("/api/orders")
      .set(customerAuth)
      .send({ shopId: NONEXISTENT_UUID, items: [{ productId: chocolateId, quantity: 1 }] });

    // 404 from the lookup — proving it got past format validation.
    expect(res.status).toBe(404);
  });
});

describe("Order access control", () => {
  it("requires a token", async () => {
    await http().get("/api/orders").expect(401);
    await http().post("/api/orders").send({ shopId: pilotShopId, items: [] }).expect(401);
  });

  it("blocks a merchant from placing customer orders", async () => {
    const merchantToken = await login("+962791234567");
    const res = await http()
      .post("/api/orders")
      .set({ Authorization: `Bearer ${merchantToken}` })
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 1 }] });

    expect(res.status).toBe(403);
  });

  it("never shows one customer another customer's order", async () => {
    const mine = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1 }]);
    const other = await newCustomer();

    // Not in their list...
    const list = await http().get("/api/orders").set(other.auth).expect(200);
    expect(list.body.map((o: { id: string }) => o.id)).not.toContain(mine.body.id);

    // ...and not readable even with the exact id.
    await http().get(`/api/orders/${mine.body.id}`).set(other.auth).expect(404);
  });

  it("lists the caller's own orders newest first", async () => {
    const fresh = await newCustomer();

    const first = await placeOrder(fresh.auth, [{ productId: chocolateId, quantity: 1 }]);
    const second = await placeOrder(fresh.auth, [{ productId: foilId, quantity: 1 }]);

    const list = await http().get("/api/orders").set(fresh.auth).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].id).toBe(second.body.id);
    expect(list.body[1].id).toBe(first.body.id);
    expect(list.body[0].shopName).toBe("Al-Nus Dinar Shop");
  });
});

describe("Delivery fee quote", () => {
  it("reports the fee so the cart can show a total before checkout", async () => {
    const res = await http().get("/api/orders/quote").set(customerAuth).expect(200);

    expect(res.body.deliveryFee).toBe("0.50");
    expect(res.body.paymentMethod).toBe("cash_on_delivery");
  });

  it("charges exactly the quoted fee", async () => {
    const quote = await http().get("/api/orders/quote").set(customerAuth).expect(200);
    const order = await placeOrder(customerAuth, [{ productId: chocolateId, quantity: 1 }]);

    expect(order.body.deliveryFee).toBe(quote.body.deliveryFee);
  });
});
