/**
 * Phase 1 integration tests — run against the real PostgreSQL database.
 *
 * These tests do two things:
 *   1. Confirm the seeded data exists with its relationships intact.
 *   2. Prove the database *rejects* invalid data. A constraint that exists but
 *      does not fire is worthless, so every constraint is tested by attempting
 *      a write that must fail.
 *
 * Run with: npm run test:db  (requires `docker compose up -d` and `npm run seed`)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — cannot run integration tests.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** Phone number used only by these tests, so seeded accounts are never touched. */
const TEST_CUSTOMER_PHONE = "+962780000001";

/** Ids created during the run, torn down in afterAll. */
let merchantId: string;
let categoryId: string;
let productId: string;
let testCustomerId: string;
const createdOrderIds: string[] = [];

beforeAll(async () => {
  // Pinned to the seeded pilot shop by name. `findFirstOrThrow()` with no filter
  // could pick up a shop another suite left behind and test the wrong data.
  const merchant = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
  });
  merchantId = merchant.id;

  const product = await prisma.product.findFirstOrThrow({
    where: { isAvailable: true, merchantId: merchant.id },
  });
  productId = product.id;
  categoryId = product.categoryId;

  const customer = await prisma.user.upsert({
    where: { phoneNumber: TEST_CUSTOMER_PHONE },
    update: {},
    create: { phoneNumber: TEST_CUSTOMER_PHONE, role: "CUSTOMER", otpVerified: true },
  });
  testCustomerId = customer.id;
});

afterAll(async () => {
  // Orders cascade to their order_items, so deleting the order is enough.
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.user.deleteMany({ where: { phoneNumber: TEST_CUSTOMER_PHONE } });
  await prisma.$disconnect();
});

/** Creates a pending order owned by the test customer, tracked for cleanup. */
async function createTestOrder(totalPrice = "1.00") {
  const order = await prisma.order.create({
    data: { customerId: testCustomerId, merchantId, totalPrice, deliveryFee: "0.50" },
  });
  createdOrderIds.push(order.id);
  return order;
}

/**
 * These verify the SEED, not the whole database.
 *
 * They are therefore scoped to the seeded pilot shop and the seeded categories.
 * Asserting global counts ("exactly one merchant exists") made them fail the
 * moment any other suite left a test shop behind — reporting a broken seed when
 * the seed was fine. Test-data cleanup is `npm run db:clean-test-data`.
 */
describe("Seeded data", () => {
  it("has the pilot merchant, linked to a user with the MERCHANT role", async () => {
    const merchants = await prisma.merchant.findMany({
      where: { shopName: "Al-Nus Dinar Shop" },
      include: { user: true },
    });

    expect(merchants).toHaveLength(1);
    expect(merchants[0].status).toBe("APPROVED");
    expect(merchants[0].user.role).toBe("MERCHANT");
    expect(merchants[0].user.id).toBe(merchants[0].userId);
  });

  it("has a category tree with root categories and subcategories correctly linked", async () => {
    const SEEDED_ROOTS = ["Household", "Food & Snacks", "Personal Care", "Stationery"];

    const roots = await prisma.category.findMany({
      where: { parentCategoryId: null, name: { in: SEEDED_ROOTS } },
      include: { subcategories: true },
    });

    expect(roots).toHaveLength(4);

    const household = roots.find((c) => c.name === "Household");
    expect(household).toBeDefined();
    expect(household!.subcategories.map((s) => s.name).sort()).toEqual([
      "Cleaning Supplies",
      "Kitchen",
    ]);
    // Every subcategory must point back at its parent.
    for (const sub of household!.subcategories) {
      expect(sub.parentCategoryId).toBe(household!.id);
    }
  });

  it("has 20 products for the pilot shop, each resolving to a merchant and a category", async () => {
    const products = await prisma.product.findMany({
      where: { merchantId },
      include: { merchant: true, category: true },
    });

    expect(products).toHaveLength(20);
    for (const p of products) {
      expect(p.merchant).not.toBeNull();
      expect(p.category).not.toBeNull();
      expect(p.merchantId).toBe(merchantId);
    }
  });

  it("stores prices as exact Decimals, not floats", async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { name: "Chocolate Bar 30g" },
    });

    // A Decimal arrives as an object; a float would arrive as a JS number.
    expect(typeof product.price).toBe("object");
    expect(product.price.toFixed(2)).toBe("0.50");
  });

  it("keeps the pilot shop's unavailable product flagged as unavailable", async () => {
    const unavailable = await prisma.product.findMany({
      where: { isAvailable: false, merchantId },
    });

    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].name).toBe("Energy Drink 250ml");
  });
});

describe("Database rejects invalid data", () => {
  it("rejects a negative product price", async () => {
    await expect(
      prisma.product.create({
        data: { merchantId, categoryId, name: "Invalid Negative Price", price: "-1.00" },
      }),
    ).rejects.toThrow(/products_price_non_negative/);
  });

  it("rejects a negative order total", async () => {
    await expect(
      prisma.order.create({
        data: { customerId: testCustomerId, merchantId, totalPrice: "-5.00" },
      }),
    ).rejects.toThrow(/orders_total_price_non_negative/);
  });

  it("rejects a negative delivery fee", async () => {
    await expect(
      prisma.order.create({
        data: { customerId: testCustomerId, merchantId, totalPrice: "1.00", deliveryFee: "-0.50" },
      }),
    ).rejects.toThrow(/orders_delivery_fee_non_negative/);
  });

  it("rejects an order item with zero quantity", async () => {
    const order = await createTestOrder();

    await expect(
      prisma.orderItem.create({
        data: { orderId: order.id, productId, quantity: 0, priceAtOrder: "0.50" },
      }),
    ).rejects.toThrow(/order_items_quantity_positive/);
  });

  it("rejects a commission rate above 100%", async () => {
    await expect(
      prisma.merchant.update({ where: { id: merchantId }, data: { commissionRate: "1.5000" } }),
    ).rejects.toThrow(/merchants_commission_rate_range/);
  });

  it("rejects a review rating outside the 1..5 range", async () => {
    const order = await createTestOrder();

    await expect(
      prisma.review.create({ data: { orderId: order.id, rating: 6 } }),
    ).rejects.toThrow(/reviews_rating_range/);
  });

  it("rejects a cancelled order that does not say who cancelled it", async () => {
    const order = await createTestOrder();

    await expect(
      prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } }),
    ).rejects.toThrow(/orders_cancelled_by_matches_status/);
  });

  it("rejects a duplicate phone number", async () => {
    await expect(
      prisma.user.create({ data: { phoneNumber: TEST_CUSTOMER_PHONE, role: "CUSTOMER" } }),
    ).rejects.toThrow();
  });

  it("rejects a product pointing at a category that does not exist", async () => {
    await expect(
      prisma.product.create({
        data: {
          merchantId,
          categoryId: "00000000-0000-0000-0000-000000000000",
          name: "Orphan Product",
          price: "0.50",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("Referential behaviour", () => {
  it("never recalculates price_at_order when the product price later changes", async () => {
    const order = await createTestOrder();
    const original = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    // Snapshot the price onto the order line, exactly as Phase 4 will.
    const item = await prisma.orderItem.create({
      data: { orderId: order.id, productId, quantity: 2, priceAtOrder: original.price },
    });

    // The merchant later reprices the product.
    await prisma.product.update({ where: { id: productId }, data: { price: "9.99" } });

    const reread = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reread.priceAtOrder.toFixed(2)).toBe(original.price.toFixed(2));
    expect(reread.priceAtOrder.toFixed(2)).not.toBe("9.99");

    // Restore the seeded price so the suite stays re-runnable.
    await prisma.product.update({ where: { id: productId }, data: { price: original.price } });
  });

  it("deletes order items when their order is deleted (cascade)", async () => {
    const order = await createTestOrder();
    await prisma.orderItem.create({
      data: { orderId: order.id, productId, quantity: 1, priceAtOrder: "0.50" },
    });

    await prisma.order.delete({ where: { id: order.id } });

    const orphans = await prisma.orderItem.count({ where: { orderId: order.id } });
    expect(orphans).toBe(0);
  });

  it("blocks deleting a product that an order still references (restrict)", async () => {
    const order = await createTestOrder();
    await prisma.orderItem.create({
      data: { orderId: order.id, productId, quantity: 1, priceAtOrder: "0.50" },
    });

    // Order history must keep pointing at the product it was placed against.
    await expect(prisma.product.delete({ where: { id: productId } })).rejects.toThrow();
  });

  it("blocks deleting a category that still has products (restrict)", async () => {
    await expect(prisma.category.delete({ where: { id: categoryId } })).rejects.toThrow();
  });
});
