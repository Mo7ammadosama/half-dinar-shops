/**
 * Demo ORDERS — so the merchant order screen and the admin console can be seen
 * working with realistic variety, not just a single hand-placed order.
 *
 * This is a companion to `seed-demo-shops.ts`. It needs the demo shops and demo
 * customers that script creates (run `npm run seed:demo` first), then places a
 * spread of orders FROM the demo customers AGAINST the demo shops, in several
 * states and — importantly — with some timestamps deliberately backdated, so the
 * merchant app's "waiting N min" urgency flag and its New / Active / Done filters
 * have something real to show.
 *
 * ── This is TEST DATA, and it is DELIBERATELY OPT-IN ───────────────────────
 * It is a SEPARATE script (not part of `seed:demo`) on purpose: the automated
 * e2e suites run against the same dev database, and a pile of demo orders could
 * skew a screenshot or an order-count. All orders here are by reserved-range
 * customers (+962780000XXX) against "[TEST] " shops, so `npm run db:clean-test-data`
 * removes every one of them. Run this when you want to DEMO; clean before you run
 * the suites.
 *
 * Most orders land on ONE flagship demo shop ("Weibdeh Mini Market", sign in as
 * 0790000101) so a single merchant login shows a full queue across every filter,
 * with a couple more elsewhere purely for admin-console variety.
 *
 * The script is idempotent: it first deletes any existing orders by the demo
 * customers, then re-creates the set, so re-running converges rather than piling
 * up duplicates.
 *
 * Run with: npm run seed:demo-orders
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** The delivery fee the app uses; mirrors backend DELIVERY_FEE_JOD (default 0.50). */
const DELIVERY_FEE = process.env.DELIVERY_FEE_JOD ?? "0.50";

const MINUTE = 60_000;

type PlannedItem = { productName: string; quantity: number; unavailable?: boolean };
type PlannedOrder = {
  shopPhone: string; // demo merchant phone (identifies the shop)
  customerPhone: string; // demo customer phone
  status: "PENDING" | "CONFIRMED" | "PREPARING" | "DELIVERED";
  ageMinutes: number; // how long ago it was "placed"
  items: PlannedItem[];
  /** For DELIVERED orders: a completed delivery + a review. */
  delivered?: { captainName: string; captainPhone: string; rating: number; comment?: string };
};

/**
 * The plan. Products are named so they resolve within the chosen shop's own
 * catalogue (see seed-demo-shops.ts). Weibdeh (0790000101) carries the full queue.
 */
const PLAN: PlannedOrder[] = [
  {
    shopPhone: "0790000101", // Weibdeh Mini Market
    customerPhone: "0780000900",
    status: "PENDING",
    ageMinutes: 14, // > 5 min → the app flags this as "waiting"
    items: [
      { productName: "Ceramic Mug", quantity: 1 },
      { productName: "Sesame Bar", quantity: 2 },
    ],
  },
  {
    shopPhone: "0790000101",
    customerPhone: "0780000901",
    status: "PENDING",
    ageMinutes: 1, // fresh — not urgent yet
    items: [{ productName: "Sparkling Water 330ml", quantity: 3 }],
  },
  {
    shopPhone: "0790000101",
    customerPhone: "0780000902",
    status: "CONFIRMED",
    ageMinutes: 25,
    items: [
      { productName: "Tea Glasses (6 pcs)", quantity: 1 },
      { productName: "Hand Soap 250ml", quantity: 1 },
    ],
  },
  {
    shopPhone: "0790000101",
    customerPhone: "0780000903",
    status: "PREPARING",
    ageMinutes: 40,
    items: [
      { productName: "Ma'moul Date Cookie", quantity: 2 },
      { productName: "Sketch Pad A4", quantity: 1, unavailable: true }, // one out of stock
    ],
  },
  {
    shopPhone: "0790000101",
    customerPhone: "0780000900",
    status: "DELIVERED",
    ageMinutes: 180,
    items: [{ productName: "Ceramic Mug", quantity: 2 }],
    delivered: { captainName: "Omar Al-Zoubi", captainPhone: "+962791122334", rating: 5, comment: "Fast and friendly." },
  },
  // A couple elsewhere, for admin-console variety.
  {
    shopPhone: "0790000102", // Shmeisani Corner Store
    customerPhone: "0780000901",
    status: "PENDING",
    ageMinutes: 6,
    items: [{ productName: "Cola Can 330ml", quantity: 2 }],
  },
  {
    shopPhone: "0790000103", // Abdoun Bargain Shop
    customerPhone: "0780000902",
    status: "DELIVERED",
    ageMinutes: 300,
    items: [{ productName: "Chocolate Wafer Roll", quantity: 3 }],
    delivered: { captainName: "Layla Nasser", captainPhone: "+962799887766", rating: 4 },
  },
];

/** Sum item lines (+ delivery fee) exactly, in integer piastres to avoid float drift. */
function totalPiastres(items: { price: string; quantity: number }[]): number {
  const itemsCents = items.reduce(
    (sum, i) => sum + Math.round(Number(i.price) * 100) * i.quantity,
    0,
  );
  return itemsCents + Math.round(Number(DELIVERY_FEE) * 100);
}

async function userIdByPhone(localPhone: string): Promise<string> {
  const phoneE164 = `+962${localPhone.replace(/^0/, "")}`;
  const user = await prisma.user.findUnique({ where: { phoneNumber: phoneE164 }, select: { id: true } });
  if (!user) {
    throw new Error(
      `Demo account ${localPhone} not found. Run the demo seed first: npm run seed:demo`,
    );
  }
  return user.id;
}

async function main() {
  console.log("Seeding demo orders...\n");

  // Idempotent reset: remove any existing orders by the demo customers so a
  // re-run converges instead of stacking duplicates. Deleting an order cascades
  // to its items, delivery and review.
  const demoCustomerIds = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: "+962780000" } },
    select: { id: true },
  });
  const removed = await prisma.order.deleteMany({
    where: { customerId: { in: demoCustomerIds.map((u) => u.id) } },
  });
  if (removed.count > 0) console.log(`(reset ${removed.count} existing demo order(s))\n`);

  for (const plan of PLAN) {
    const customerId = await userIdByPhone(plan.customerPhone);
    const shopUserId = await userIdByPhone(plan.shopPhone);
    const merchant = await prisma.merchant.findUnique({
      where: { userId: shopUserId },
      select: { id: true, shopName: true },
    });
    if (!merchant) throw new Error(`Demo shop for ${plan.shopPhone} not found. Run: npm run seed:demo`);

    // Resolve each planned item to a real product IN THIS SHOP.
    const items: {
      productId: string;
      price: string;
      quantity: number;
      status: "CONFIRMED" | "UNAVAILABLE";
    }[] = [];
    for (const it of plan.items) {
      const product = await prisma.product.findFirst({
        where: { merchantId: merchant.id, name: it.productName },
        select: { id: true, price: true },
      });
      if (!product) {
        throw new Error(
          `Product "${it.productName}" not found in ${merchant.shopName}. Re-run: npm run seed:demo`,
        );
      }
      items.push({
        productId: product.id,
        price: product.price.toString(),
        quantity: it.quantity,
        status: it.unavailable ? ("UNAVAILABLE" as const) : ("CONFIRMED" as const),
      });
    }

    const createdAt = new Date(Date.now() - plan.ageMinutes * MINUTE);
    const total = (totalPiastres(items) / 100).toFixed(2);

    const order = await prisma.order.create({
      data: {
        customerId,
        merchantId: merchant.id,
        status: plan.status,
        totalPrice: total,
        deliveryFee: DELIVERY_FEE,
        createdAt,
        orderItems: {
          create: items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            priceAtOrder: i.price,
            status: i.status,
          })),
        },
      },
    });

    if (plan.status === "DELIVERED" && plan.delivered) {
      await prisma.delivery.create({
        data: {
          orderId: order.id,
          captainName: plan.delivered.captainName,
          captainPhone: plan.delivered.captainPhone,
          status: "DELIVERED",
          deliveredAt: new Date(createdAt.getTime() + 40 * MINUTE),
        },
      });
      await prisma.review.create({
        data: { orderId: order.id, rating: plan.delivered.rating, comment: plan.delivered.comment ?? null },
      });
    }

    console.log(
      `  ${merchant.shopName.padEnd(28)} ${plan.status.padEnd(10)} ` +
        `${plan.ageMinutes}m ago · ${items.length} item(s) · ${total} JOD`,
    );
  }

  console.log(`\nSeeded ${PLAN.length} demo orders.`);
  console.log('Sign in to the merchant app as 0790000101 ("Weibdeh Mini Market") to see the full queue.');
  console.log("Remove them any time with:  npm run db:clean-test-data");
}

main()
  .catch((e) => {
    console.error("Demo-order seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
