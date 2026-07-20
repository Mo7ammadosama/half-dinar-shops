/**
 * Dev-only helper: clears ALL orders (and their items/deliveries/reviews).
 *
 * Every order in the local dev database is test-generated (COD, no real
 * customers), and the documented clean seed state is 0 orders. Leftover orders
 * from e2e runs whose customers are outside the reserved +962780000XXX range are
 * not swept by db:clean-test-data, and they block `seed` from resetting the
 * pilot's products (FK RESTRICT). Run this, then `seed`, to restore that state.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const reviews = await prisma.review.deleteMany({});
  const deliveries = await prisma.delivery.deleteMany({});
  const items = await prisma.orderItem.deleteMany({});
  const orders = await prisma.order.deleteMany({});
  console.log(
    `Cleared ${orders.count} orders, ${items.count} items, ${deliveries.count} deliveries, ${reviews.count} reviews.`,
  );
  await prisma.$disconnect();
}

void main();
