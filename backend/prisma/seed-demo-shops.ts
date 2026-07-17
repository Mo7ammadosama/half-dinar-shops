/**
 * Demo shops for exercising the "nearest shop" experience.
 *
 * The pilot ships with ONE shop, which makes it impossible to see the customer
 * app sort shops by distance. This script adds a handful of extra APPROVED shops
 * at real Amman coordinates spread from ~1 km to ~9 km from the downtown pilot,
 * each with its own small catalogue, so a customer sees a list of shops ordered
 * by how near they are.
 *
 * ── This is TEST DATA ──────────────────────────────────────────────────────
 * Every shop here is name-prefixed "[TEST] ", exactly like the shops the browser
 * tests create. That means `npm run db:clean-test-data` removes them with no
 * change — but it also means routine cleanup DELETES these demo shops. Re-run
 * this script to bring them back:  npm run seed:demo
 *
 * The script is idempotent: users are upserted by phone, merchants by user, and
 * each merchant's products are reset before re-insert, so re-running converges to
 * the same state rather than duplicating rows.
 *
 * Product names are deliberately DISTINCT from the pilot's 20 seeded products, so
 * that integration tests which look a product up globally by name (e.g.
 * "Chocolate Bar 30g") still resolve to the pilot's product and not a demo one.
 *
 * Run with: npm run seed:demo
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * The same "[TEST] " marker the automated suites and clean-test-data use, so the
 * existing cleanup handles these shops unchanged.
 */
const TEST_SHOP_PREFIX = "[TEST] ";

/**
 * Merchant phones for the demo shops. These accounts are tied to "[TEST] " shops,
 * so cleanup removes them via the shop prefix. They sit outside the reserved
 * customer test range (+962780000XXX) so the two never collide.
 */
type DemoShop = {
  phone: string;
  shopName: string;
  lat: number;
  lng: number;
  openingHours: string;
  /** Category name -> products. Categories are looked up from the seeded tree. */
  products: Array<{ name: string; price: string; category: string; available?: boolean }>;
};

/**
 * Five shops at real Amman coordinates, at increasing distance from the pilot
 * (downtown Al-Balad, 31.9539 / 35.9106):
 *   Weibdeh ~1.1 km · Shmeisani ~2.0 km · Abdoun ~3.1 km ·
 *   Sweifieh ~4.8 km · Khalda ~8.8 km
 */
const DEMO_SHOPS: DemoShop[] = [
  {
    phone: "0790000101",
    shopName: "Weibdeh Mini Market",
    lat: 31.96,
    lng: 35.902,
    openingHours: "07:00-24:00",
    products: [
      { name: "Ceramic Mug", price: "0.75", category: "Kitchen" },
      { name: "Tea Glasses (6 pcs)", price: "0.90", category: "Kitchen" },
      { name: "Ma'moul Date Cookie", price: "0.30", category: "Biscuits & Sweets" },
      { name: "Sesame Bar", price: "0.25", category: "Biscuits & Sweets" },
      { name: "Sparkling Water 330ml", price: "0.40", category: "Drinks" },
      { name: "Hand Soap 250ml", price: "0.60", category: "Personal Care" },
      { name: "Sketch Pad A4", price: "0.55", category: "Stationery" },
    ],
  },
  {
    phone: "0790000102",
    shopName: "Shmeisani Corner Store",
    lat: 31.97,
    lng: 35.901,
    openingHours: "08:00-23:00",
    products: [
      { name: "Dish Brush", price: "0.45", category: "Cleaning Supplies" },
      { name: "Floor Cloth", price: "0.50", category: "Cleaning Supplies" },
      { name: "Cling Film Roll", price: "0.65", category: "Kitchen" },
      { name: "Cheese Crackers", price: "0.35", category: "Biscuits & Sweets" },
      { name: "Cola Can 330ml", price: "0.45", category: "Drinks" },
      { name: "Iced Tea 250ml", price: "0.40", category: "Drinks" },
      { name: "Shampoo Sachet", price: "0.15", category: "Personal Care" },
      { name: "Highlighter Pen", price: "0.50", category: "Stationery" },
    ],
  },
  {
    phone: "0790000103",
    shopName: "Abdoun Bargain Shop",
    lat: 31.945,
    lng: 35.879,
    openingHours: "09:00-22:00",
    products: [
      { name: "Storage Basket", price: "0.95", category: "Kitchen" },
      { name: "Clothes Pegs (20 pcs)", price: "0.50", category: "Cleaning Supplies" },
      { name: "Glass Cleaner Spray", price: "0.85", category: "Cleaning Supplies" },
      { name: "Chocolate Wafer Roll", price: "0.55", category: "Biscuits & Sweets" },
      { name: "Orange Soda 330ml", price: "0.45", category: "Drinks" },
      { name: "Cotton Buds Pack", price: "0.35", category: "Personal Care" },
      { name: "Sticky Tape Roll", price: "0.30", category: "Stationery" },
    ],
  },
  {
    phone: "0790000104",
    shopName: "Sweifieh Value Store",
    lat: 31.95,
    lng: 35.86,
    openingHours: "08:30-23:30",
    products: [
      { name: "Non-Stick Spatula", price: "0.70", category: "Kitchen" },
      { name: "Bin Liners (30 pcs)", price: "0.60", category: "Cleaning Supplies" },
      { name: "Shortbread Fingers", price: "0.45", category: "Biscuits & Sweets" },
      { name: "Lemon Mint Drink 250ml", price: "0.50", category: "Drinks" },
      { name: "Energy Drink 500ml", price: "0.95", category: "Drinks", available: false },
      { name: "Face Cloth", price: "0.40", category: "Personal Care" },
      { name: "Sticky Notes Cube", price: "0.65", category: "Stationery" },
    ],
  },
  {
    phone: "0790000105",
    shopName: "Khalda Everything Shop",
    lat: 31.993,
    lng: 35.83,
    openingHours: "07:30-23:00",
    products: [
      { name: "Measuring Jug 1L", price: "0.80", category: "Kitchen" },
      { name: "Sponge Scourers (3 pcs)", price: "0.55", category: "Cleaning Supplies" },
      { name: "Digestive Biscuits", price: "0.50", category: "Biscuits & Sweets" },
      { name: "Peanut Snack Pack", price: "0.35", category: "Biscuits & Sweets" },
      { name: "Mango Juice 250ml", price: "0.55", category: "Drinks" },
      { name: "Toothpaste 50ml", price: "0.85", category: "Personal Care" },
      { name: "Colour Pencils (12)", price: "0.90", category: "Stationery" },
    ],
  },
];

/** Resolves a category id by its name from the seeded tree. */
async function categoryIdByName(name: string): Promise<string> {
  const category = await prisma.category.findFirst({ where: { name }, select: { id: true } });
  if (!category) {
    throw new Error(
      `Category "${name}" not found. Run the base seed first: npm run seed`,
    );
  }
  return category.id;
}

async function main() {
  console.log("Seeding demo shops...\n");

  // Cache category ids so we hit the database once per category, not per product.
  const categoryCache = new Map<string, string>();
  const resolveCategory = async (name: string): Promise<string> => {
    const cached = categoryCache.get(name);
    if (cached) return cached;
    const id = await categoryIdByName(name);
    categoryCache.set(name, id);
    return id;
  };

  for (const shop of DEMO_SHOPS) {
    const phoneE164 = `+962${shop.phone.replace(/^0/, "")}`;

    const user = await prisma.user.upsert({
      where: { phoneNumber: phoneE164 },
      update: { role: "MERCHANT", otpVerified: true },
      create: { phoneNumber: phoneE164, role: "MERCHANT", otpVerified: true },
    });

    const merchant = await prisma.merchant.upsert({
      where: { userId: user.id },
      update: {
        shopName: `${TEST_SHOP_PREFIX}${shop.shopName}`,
        locationLat: shop.lat,
        locationLng: shop.lng,
        openingHours: shop.openingHours,
        status: "APPROVED",
      },
      create: {
        userId: user.id,
        shopName: `${TEST_SHOP_PREFIX}${shop.shopName}`,
        locationLat: shop.lat,
        locationLng: shop.lng,
        openingHours: shop.openingHours,
        status: "APPROVED",
        commissionRate: "0.1500",
      },
    });

    // Reset this shop's products so re-running does not duplicate them.
    await prisma.product.deleteMany({ where: { merchantId: merchant.id } });

    for (const p of shop.products) {
      await prisma.product.create({
        data: {
          merchantId: merchant.id,
          categoryId: await resolveCategory(p.category),
          name: p.name,
          price: p.price,
          isAvailable: p.available ?? true,
          imageUrl: null,
        },
      });
    }

    console.log(
      `  ${TEST_SHOP_PREFIX}${shop.shopName.padEnd(24)} ` +
        `(${shop.products.length} products)  @ ${shop.lat}, ${shop.lng}`,
    );
  }

  console.log(`\nSeeded ${DEMO_SHOPS.length} demo shops (all APPROVED, all "[TEST] "-marked).`);
  console.log("Remove them any time with:  npm run db:clean-test-data");
}

main()
  .catch((e) => {
    console.error("Demo seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
