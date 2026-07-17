/**
 * Removes accounts created by automated UI tests.
 *
 * The browser tests drive the real UI, so they leave real rows in the
 * development database. Two markers make them identifiable:
 *
 *   - Merchant shops registered by the dashboard tests are name-prefixed "[TEST] ".
 *   - Customers created by the mobile app tests use the reserved phone range
 *     +962780000XXX (local 0780000000–0780000999).
 *
 * Both are deleted here and nothing else. Deleting a user cascades to their
 * merchant profile and its products.
 *
 * Run with: npm run db:clean-test-data
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const TEST_SHOP_PREFIX = "[TEST] ";

/** Reserved for automated tests. Never issue these to real customers. */
const TEST_CUSTOMER_PHONE_PREFIX = "+962780000";

/** Master categories created by admin-panel tests. Never use for real ones. */
const TEST_CATEGORY_PREFIX = "ZZ ";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  const testMerchants = await prisma.merchant.findMany({
    where: { shopName: { startsWith: TEST_SHOP_PREFIX } },
    select: { userId: true, shopName: true, _count: { select: { products: true } } },
  });

  const testCustomers = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: TEST_CUSTOMER_PHONE_PREFIX } },
    select: { id: true, phoneNumber: true },
  });

  /**
   * Test-marked products sitting inside a REAL shop.
   *
   * Gap found in Phase 8: this script only ever removed products belonging to
   * a `[TEST] `-prefixed *shop*. A browser test that adds a `[TEST] `-prefixed
   * *product* to the pilot shop — which the AI-product-entry test does, since
   * it must drive the real dashboard against a real catalogue — left it behind
   * forever. That one row then failed two suites ("expected 20 products,
   * received 21") in a way that reads like a broken seed rather than leftover
   * test data.
   *
   * Read BEFORE the early return: stray products can exist with no test
   * accounts at all, which is exactly the case that was slipping through.
   */
  const strayProducts = await prisma.product.findMany({
    where: { name: { startsWith: TEST_SHOP_PREFIX } },
    select: { id: true, name: true, merchantId: true, _count: { select: { orderItems: true } } },
  });
  const testMerchantIds = new Set(
    (
      await prisma.merchant.findMany({
        where: { shopName: { startsWith: TEST_SHOP_PREFIX } },
        select: { id: true },
      })
    ).map((m) => m.id),
  );
  // Only the ones in real shops — those in test shops go with their shop below.
  const strayInRealShops = strayProducts.filter((p) => !testMerchantIds.has(p.merchantId));

  if (testMerchants.length === 0 && testCustomers.length === 0 && strayInRealShops.length === 0) {
    console.log("No test accounts or stray test products found. Nothing to clean.");
    return;
  }

  // Orders placed BY a test customer or AGAINST a test shop are test data by
  // definition — the "[TEST] " prefix and the reserved phone range are only ever
  // used by the automated suites. They must be deleted first: orders restrict
  // deletion of their customer and merchant, so removing the user would
  // otherwise fail. Deleting an order cascades to its order_items.
  //
  // Nothing outside those two markers is ever touched, so a real customer's
  // order cannot be caught by this.
  const testOrders = await prisma.order.findMany({
    where: {
      OR: [
        { customer: { phoneNumber: { startsWith: TEST_CUSTOMER_PHONE_PREFIX } } },
        { merchant: { shopName: { startsWith: TEST_SHOP_PREFIX } } },
      ],
    },
    select: { id: true },
  });

  if (testOrders.length > 0) {
    // Deliveries and reviews cascade with their order.
    const { count } = await prisma.order.deleteMany({
      where: { id: { in: testOrders.map((o) => o.id) } },
    });
    console.log(`Removed ${count} test order(s) and their items.`);
  }

  if (testMerchants.length > 0) {
    console.log(`Removing ${testMerchants.length} test shop(s):`);
    for (const m of testMerchants) {
      console.log(`  ${m.shopName} (${m._count.products} products)`);
    }
  }
  if (testCustomers.length > 0) {
    console.log(`Removing ${testCustomers.length} test customer account(s).`);
  }

  const { count } = await prisma.user.deleteMany({
    where: {
      OR: [
        { id: { in: testMerchants.map((m) => m.userId) } },
        { phoneNumber: { startsWith: TEST_CUSTOMER_PHONE_PREFIX } },
      ],
    },
  });

  console.log(`\nDeleted ${count} test account(s) and their shops/products.`);

  // Stray test products in real shops (found above, before the early return).
  // Same guarantee as everywhere else here: an ordered product is never
  // touched, so real order history cannot be destroyed.
  const ordered = strayInRealShops.filter((p) => p._count.orderItems > 0);
  const removable = strayInRealShops.filter((p) => p._count.orderItems === 0);

  if (ordered.length > 0) {
    console.log(
      `\nLeaving ${ordered.length} test product(s) that appear in real orders — ` +
        `deleting them would destroy order history:`,
    );
    for (const p of ordered) console.log(`  ${p.name}`);
  }

  if (removable.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: removable.map((p) => p.id) } } });
    console.log(`Deleted ${removable.length} stray test product(s) from real shops.`);
  }

  // Test categories are deleted last: their products belong to the test shops
  // above, so they only become empty once those are gone. Subcategories first,
  // because a parent cannot be deleted while children point at it.
  const testCategories = await prisma.category.findMany({
    where: { name: { startsWith: TEST_CATEGORY_PREFIX } },
    select: { id: true, name: true, parentCategoryId: true, _count: { select: { products: true } } },
  });

  const stillUsed = testCategories.filter((c) => c._count.products > 0);
  if (stillUsed.length > 0) {
    console.warn(
      `Left ${stillUsed.length} test category(ies) in place — real products still use them: ` +
        stillUsed.map((c) => c.name).join(", "),
    );
  }

  const deletable = testCategories.filter((c) => c._count.products === 0);
  const children = deletable.filter((c) => c.parentCategoryId !== null);
  const roots = deletable.filter((c) => c.parentCategoryId === null);

  for (const group of [children, roots]) {
    if (group.length === 0) continue;
    await prisma.category.deleteMany({ where: { id: { in: group.map((c) => c.id) } } });
  }

  if (deletable.length > 0) {
    console.log(`Deleted ${deletable.length} test category(ies).`);
  }
}

main()
  .catch((e) => {
    console.error("Cleanup failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
