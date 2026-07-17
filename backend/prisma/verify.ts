/**
 * Phase 1 verification script.
 *
 * Reads the seeded data back out of PostgreSQL *through its relationships*
 * (merchant -> user, product -> merchant, product -> category -> parent) to
 * prove the foreign keys resolve and the data is intact.
 *
 * This is a read-only report. Run with: npm run verify
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  console.log("=".repeat(72));
  console.log("PHASE 1 VERIFICATION — reading seeded data back from PostgreSQL");
  console.log("=".repeat(72));

  // --- Merchant, resolved through its user relation ------------------------
  const merchant = await prisma.merchant.findFirstOrThrow({
    include: { user: true },
  });

  console.log("\n[1] MERCHANT (joined to its owning user)");
  console.log(`    shop_name       : ${merchant.shopName}`);
  console.log(`    status          : ${merchant.status}`);
  console.log(`    location        : ${merchant.locationLat}, ${merchant.locationLng}`);
  console.log(`    opening_hours   : ${merchant.openingHours}`);
  console.log(`    commission_rate : ${merchant.commissionRate.toString()}`);
  console.log(`    -> user.phone   : ${merchant.user.phoneNumber}`);
  console.log(`    -> user.role    : ${merchant.user.role}`);
  console.log(`    FK resolved     : ${merchant.user.id === merchant.userId ? "YES" : "NO"}`);

  // --- Category tree, resolved through the self-referencing relation -------
  const rootCategories = await prisma.category.findMany({
    where: { parentCategoryId: null },
    include: {
      subcategories: {
        include: { _count: { select: { products: true } } },
        orderBy: { name: "asc" },
      },
      _count: { select: { products: true } },
    },
    orderBy: { name: "asc" },
  });

  console.log("\n[2] CATEGORY TREE (self-referencing parent -> subcategories)");
  for (const root of rootCategories) {
    console.log(`    ${root.name}  (${root._count.products} products directly)`);
    for (const sub of root.subcategories) {
      console.log(`      |- ${sub.name}  (${sub._count.products} products)`);
    }
  }

  // --- Products, resolved through merchant + category relations ------------
  const products = await prisma.product.findMany({
    include: { category: { include: { parentCategory: true } }, merchant: true },
    orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
  });

  console.log("\n[3] PRODUCTS (joined to merchant and category, showing full category path)");
  console.log(
    `    ${"PRODUCT".padEnd(34)} ${"PRICE".padStart(6)}  ${"AVAIL".padEnd(6)} CATEGORY PATH`,
  );
  console.log(`    ${"-".repeat(34)} ${"-".repeat(6)}  ${"-".repeat(6)} ${"-".repeat(28)}`);
  for (const p of products) {
    const path = p.category.parentCategory
      ? `${p.category.parentCategory.name} > ${p.category.name}`
      : p.category.name;
    const avail = p.isAvailable ? "yes" : "NO";
    console.log(
      `    ${p.name.padEnd(34)} ${p.price.toFixed(2).padStart(6)}  ${avail.padEnd(6)} ${path}`,
    );
  }

  // --- Integrity summary ---------------------------------------------------
  // Each check below compares data actually returned by the join, so a broken
  // foreign key would surface as a missing related row rather than a pass.
  const joinedCategory = products.filter((p) => p.category != null).length;
  const joinedMerchant = products.filter((p) => p.merchant != null).length;
  const allBelongToMerchant = products.every((p) => p.merchantId === merchant.id);

  // Prisma returns Decimal columns as Decimal objects; a float would arrive as
  // a JS number. This asserts money did not silently degrade to floating point.
  const priceIsDecimal = products.every((p) => typeof p.price === "object");

  console.log("\n[4] INTEGRITY CHECKS");
  console.log(`    total products                     : ${products.length}`);
  console.log(
    `    products whose merchant row joined : ${joinedMerchant}/${products.length} ${joinedMerchant === products.length ? "OK" : "FAIL"}`,
  );
  console.log(
    `    products whose category row joined : ${joinedCategory}/${products.length} ${joinedCategory === products.length ? "OK" : "FAIL"}`,
  );
  console.log(`    all products -> pilot merchant     : ${allBelongToMerchant ? "OK" : "FAIL"}`);
  console.log(`    price is Decimal (not float)       : ${priceIsDecimal ? "OK" : "FAIL"}`);
  console.log(
    `    unavailable products               : ${products.filter((p) => !p.isAvailable).length}`,
  );

  console.log("\n" + "=".repeat(72));
  console.log("VERIFICATION COMPLETE");
  console.log("=".repeat(72));
}

main()
  .catch((e) => {
    console.error("Verification failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
