/**
 * Seed script for local development.
 *
 * Creates the pilot shop's dataset: one merchant, a category tree (roots +
 * subcategories, exercising the self-referencing relationship), and a set of
 * products priced around the 0.5 JOD "half-dinar" mark.
 *
 * Safe to run repeatedly: every write is an upsert keyed on a natural key, and
 * the merchant's products are reset before being re-inserted. Re-running the
 * seed therefore converges to the same state rather than duplicating rows.
 *
 * Run with: npm run seed
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Prisma 7 talks to PostgreSQL through a driver adapter rather than a bundled engine.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** Jordanian phone numbers are stored E.164-normalized. */
const MERCHANT_PHONE = "+962791234567";
const CUSTOMER_PHONE = "+962791111111";
const ADMIN_PHONE = "+962799999999";

/** Pilot shop location: Downtown Amman. */
const SHOP_LAT = 31.9539;
const SHOP_LNG = 35.9106;

/**
 * Upserts a category by its natural key (parent + name).
 *
 * `upsert` needs a unique selector, and the schema's unique key is the
 * composite (parent_category_id, name). PostgreSQL treats NULLs as distinct in
 * unique indexes, so that composite cannot be used as an upsert selector for
 * root categories (parent is NULL). Root categories are therefore matched with
 * an explicit findFirst instead.
 */
async function upsertCategory(name: string, parentCategoryId: string | null): Promise<string> {
  const existing = await prisma.category.findFirst({
    where: { name, parentCategoryId },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await prisma.category.create({
    data: { name, parentCategoryId },
    select: { id: true },
  });
  return created.id;
}

async function main() {
  console.log("Seeding database...\n");

  // --- Users -------------------------------------------------------------
  // NOTE: no password/OTP secret is stored yet. Authentication (phone + OTP,
  // hashed with argon2) is built in Phase 2/3 — this seed only creates the
  // identity rows those phases will authenticate against.
  const merchantUser = await prisma.user.upsert({
    where: { phoneNumber: MERCHANT_PHONE },
    update: { role: "MERCHANT", otpVerified: true },
    create: { phoneNumber: MERCHANT_PHONE, role: "MERCHANT", otpVerified: true },
  });

  const customerUser = await prisma.user.upsert({
    where: { phoneNumber: CUSTOMER_PHONE },
    update: { role: "CUSTOMER", otpVerified: true },
    create: { phoneNumber: CUSTOMER_PHONE, role: "CUSTOMER", otpVerified: true },
  });

  const adminUser = await prisma.user.upsert({
    where: { phoneNumber: ADMIN_PHONE },
    update: { role: "ADMIN", otpVerified: true },
    create: { phoneNumber: ADMIN_PHONE, role: "ADMIN", otpVerified: true },
  });

  console.log(`  users:      3 (merchant, customer, admin)`);

  // --- Merchant (the single pilot shop) ----------------------------------
  const merchant = await prisma.merchant.upsert({
    where: { userId: merchantUser.id },
    update: {},
    create: {
      userId: merchantUser.id,
      shopName: "Al-Nus Dinar Shop",
      locationLat: SHOP_LAT,
      locationLng: SHOP_LNG,
      openingHours: "08:00-23:00",
      status: "APPROVED", // pilot shop is pre-approved so later phases have a working shop
      commissionRate: "0.1500", // 15%
    },
  });

  console.log(`  merchants:  1 (${merchant.shopName})`);

  // --- Categories (admin-managed, shared across all merchants) ------------
  // Two levels deep to prove the self-referencing parent/child relationship.
  const household = await upsertCategory("Household", null);
  const foodSnacks = await upsertCategory("Food & Snacks", null);
  const personalCare = await upsertCategory("Personal Care", null);
  const stationery = await upsertCategory("Stationery", null);

  const cleaning = await upsertCategory("Cleaning Supplies", household);
  const kitchen = await upsertCategory("Kitchen", household);
  const biscuits = await upsertCategory("Biscuits & Sweets", foodSnacks);
  const drinks = await upsertCategory("Drinks", foodSnacks);

  console.log(`  categories: 8 (4 root + 4 subcategories)`);

  // --- Products ----------------------------------------------------------
  // Reset this merchant's products first so re-running the seed does not
  // duplicate them (products have no natural unique key).
  await prisma.product.deleteMany({ where: { merchantId: merchant.id } });

  const products: Array<{
    name: string;
    price: string;
    categoryId: string;
    isAvailable?: boolean;
  }> = [
    // Cleaning Supplies
    { name: "Dish Sponge (2 pcs)", price: "0.50", categoryId: cleaning },
    { name: "Scouring Pad", price: "0.35", categoryId: cleaning },
    { name: "Multi-Purpose Cleaning Cloth", price: "0.50", categoryId: cleaning },
    { name: "Rubber Gloves", price: "0.75", categoryId: cleaning },
    // Kitchen
    { name: "Plastic Food Container 500ml", price: "0.50", categoryId: kitchen },
    { name: "Aluminium Foil Roll", price: "0.90", categoryId: kitchen },
    { name: "Wooden Spoon", price: "0.50", categoryId: kitchen },
    // Biscuits & Sweets
    { name: "Wafer Biscuit Bar", price: "0.25", categoryId: biscuits },
    { name: "Chocolate Bar 30g", price: "0.50", categoryId: biscuits },
    { name: "Salted Crackers Pack", price: "0.50", categoryId: biscuits },
    // Drinks
    { name: "Mineral Water 600ml", price: "0.35", categoryId: drinks },
    { name: "Orange Juice Box 250ml", price: "0.50", categoryId: drinks },
    // Marked unavailable so later phases have an out-of-stock case to exercise.
    { name: "Energy Drink 250ml", price: "0.75", categoryId: drinks, isAvailable: false },
    // Personal Care
    { name: "Bar Soap 100g", price: "0.50", categoryId: personalCare },
    { name: "Toothbrush", price: "0.50", categoryId: personalCare },
    { name: "Paper Tissues Pack", price: "0.25", categoryId: personalCare },
    // Stationery
    { name: "Ballpoint Pen (Blue)", price: "0.20", categoryId: stationery },
    { name: "A5 Notebook 40 pages", price: "0.50", categoryId: stationery },
    { name: "Pencil Eraser", price: "0.15", categoryId: stationery },
    { name: "Wooden Ruler 30cm", price: "0.50", categoryId: stationery },
  ];

  await prisma.product.createMany({
    data: products.map((p) => ({
      merchantId: merchant.id,
      categoryId: p.categoryId,
      name: p.name,
      price: p.price,
      isAvailable: p.isAvailable ?? true,
      imageUrl: null, // real photos are uploaded through the merchant dashboard in Phase 2
    })),
  });

  console.log(`  products:   ${products.length} (1 marked unavailable)`);
  console.log("\nSeed complete.");
  console.log("\nTest accounts:");
  console.log(`  merchant  ${MERCHANT_PHONE}  -> ${merchant.shopName}`);
  console.log(`  customer  ${CUSTOMER_PHONE}`);
  console.log(`  admin     ${ADMIN_PHONE}`);

  // Referenced so linters do not flag the intentionally-created test accounts.
  void customerUser;
  void adminUser;
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
