/**
 * Phase 5 — the merchant order handling loop.
 *
 * Covers the full cycle: customer places, merchant confirms/rejects items,
 * status transitions, and the cancellation rules from the spec:
 *
 *   - Customer cancels FREELY while PENDING.
 *   - Customer cancels during PREPARING (the app warns first).
 *   - Once DELIVERING, cancellation is BLOCKED.
 *   - Merchant cancels only during CONFIRMED/PREPARING, with a mandatory reason.
 *   - An out-of-stock item does NOT cancel the order; the total recalculates
 *     only once the customer confirms removal.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NotificationsService } from "../src/orders/notifications.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
let notifications: NotificationsService;
// `request(app)` returns TestAgent; ReturnType keeps this correct across
// supertest versions rather than naming a type that has since changed.
let http: () => ReturnType<typeof request>;

const createdPhones: string[] = [];

let pilotShopId: string;
let customerAuth: { Authorization: string };
let merchantAuth: { Authorization: string };

let chocolateId: string; // 0.50
let foilId: string; // 0.90
let soapId: string; // 0.50

async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

/** A fresh customer from the reserved test range. */
async function newCustomer() {
  const phoneNumber = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phoneNumber);
  return { Authorization: `Bearer ${await login(phoneNumber)}` };
}

/** Places an order as the given customer. */
async function placeOrder(
  auth: { Authorization: string },
  items: Array<{ productId: string; quantity: number }>,
) {
  const res = await http()
    .post("/api/orders")
    .set(auth)
    .send({ shopId: pilotShopId, items })
    .expect(201);
  return res.body;
}

/** Drives an order to a given status using the real merchant endpoints. */
async function driveTo(orderId: string, target: "CONFIRMED" | "PREPARING" | "DELIVERING") {
  await http().post(`/api/merchant/orders/${orderId}/confirm`).set(merchantAuth).expect(201);
  if (target === "CONFIRMED") return;

  await http().post(`/api/merchant/orders/${orderId}/start-preparing`).set(merchantAuth).expect(201);
  if (target === "PREPARING") return;

  // DELIVERING is entered in Phase 6; set directly for cancellation tests.
  await prisma.order.update({ where: { id: orderId }, data: { status: "DELIVERING" } });
}

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());
  notifications = app.get(NotificationsService);

  customerAuth = { Authorization: `Bearer ${await login("+962791111111")}` };
  merchantAuth = { Authorization: `Bearer ${await login("+962791234567")}` };

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;

  const find = async (name: string) =>
    (await prisma.product.findFirstOrThrow({ where: { name, merchantId: pilotShopId } })).id;

  chocolateId = await find("Chocolate Bar 30g");
  foilId = await find("Aluminium Foil Roll");
  soapId = await find("Bar Soap 100g");
});

afterAll(async () => {
  const testCustomers = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: "+962780000" } },
    select: { id: true },
  });
  await prisma.order.deleteMany({
    where: { customerId: { in: testCustomers.map((c) => c.id) } },
  });
  await prisma.order.deleteMany({ where: { customer: { phoneNumber: "+962791111111" } } });
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await app.close();
});

describe("The merchant sees new orders", () => {
  it("shows a newly placed order as PENDING in the shop's list", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 2 }]);

    const list = await http().get("/api/merchant/orders").set(merchantAuth).expect(200);
    const mine = list.body.find((o: { id: string }) => o.id === order.id);

    expect(mine).toBeDefined();
    expect(mine.status).toBe("PENDING");
    expect(mine.itemCount).toBe(1);
    expect(mine.totalPrice).toBe("1.50");
  });

  it("counts pending orders for the dashboard badge", async () => {
    const before = await http().get("/api/merchant/orders/pending-count").set(merchantAuth).expect(200);

    const customer = await newCustomer();
    await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    const after = await http().get("/api/merchant/orders/pending-count").set(merchantAuth).expect(200);
    expect(after.body.pending).toBe(before.body.pending + 1);
  });

  it("filters the list by status", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "CONFIRMED");

    const confirmed = await http()
      .get("/api/merchant/orders?status=CONFIRMED")
      .set(merchantAuth)
      .expect(200);

    expect(confirmed.body.every((o: { status: string }) => o.status === "CONFIRMED")).toBe(true);
    expect(confirmed.body.map((o: { id: string }) => o.id)).toContain(order.id);
  });

  it("never shows one shop another shop's orders", async () => {
    // A second approved shop with its own merchant login.
    // Jordanian mobiles are +962 7 [789] then 7 digits — 9 digits after +962.
    const phoneNumber = `+96277${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    createdPhones.push(phoneNumber);
    const otherUser = await prisma.user.create({
      data: { phoneNumber, role: "MERCHANT", otpVerified: true },
      select: { id: true },
    });
    await prisma.merchant.create({
      data: {
        userId: otherUser.id,
        shopName: "[TEST] Rival Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
        status: "APPROVED",
      },
    });

    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    const rivalAuth = { Authorization: `Bearer ${await login(phoneNumber)}` };

    const list = await http().get("/api/merchant/orders").set(rivalAuth).expect(200);
    expect(list.body.map((o: { id: string }) => o.id)).not.toContain(order.id);

    // Not even with the exact id — 404, not 403.
    await http().get(`/api/merchant/orders/${order.id}`).set(rivalAuth).expect(404);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(rivalAuth).expect(404);
  });
});

describe("Status transitions", () => {
  it("runs the happy path: PENDING -> CONFIRMED -> PREPARING", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    expect(order.status).toBe("PENDING");

    const confirmed = await http()
      .post(`/api/merchant/orders/${order.id}/confirm`)
      .set(merchantAuth)
      .expect(201);
    expect(confirmed.body.status).toBe("CONFIRMED");

    const preparing = await http()
      .post(`/api/merchant/orders/${order.id}/start-preparing`)
      .set(merchantAuth)
      .expect(201);
    expect(preparing.body.status).toBe("PREPARING");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("PREPARING");
  });

  it("refuses to skip straight from PENDING to PREPARING", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http()
      .post(`/api/merchant/orders/${order.id}/start-preparing`)
      .set(merchantAuth)
      .expect(409);
  });

  it("refuses to confirm an order twice", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(409);
  });

  it("refuses to confirm a cancelled order", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({}).expect(201);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(409);
  });

  it("notifies the customer when the shop confirms", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);

    const events = notifications.eventsFor(order.id);
    expect(events.some((e) => e.type === "order.confirmed")).toBe(true);
  });
});

describe("Out-of-stock items do not cancel the order", () => {
  it("flags the item, keeps the order alive, and leaves the total until the customer accepts", async () => {
    const customer = await newCustomer();
    // Chocolate 2x0.50 = 1.00, Foil 1x0.90 -> items 1.90 + 0.50 = 2.40
    const order = await placeOrder(customer, [
      { productId: chocolateId, quantity: 2 },
      { productId: foilId, quantity: 1 },
    ]);
    expect(order.totalPrice).toBe("2.40");

    await driveTo(order.id, "PREPARING");

    const foilItem = order.items.find((i: { productId: string }) => i.productId === foilId);

    const afterFlag = await http()
      .patch(`/api/merchant/orders/${order.id}/items/${foilItem.id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    // The order is NOT cancelled.
    expect(afterFlag.body.status).toBe("PREPARING");
    expect(afterFlag.body.hasUnavailableItems).toBe(true);
    // The stored total has NOT changed yet — the spec is explicit that it only
    // recalculates once the customer confirms removal.
    expect(afterFlag.body.totalPrice).toBe("2.40");
    // ...but the shop can see what it would become.
    expect(afterFlag.body.revisedTotal).toBe("1.50");

    const rowBefore = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(rowBefore.totalPrice.toFixed(2)).toBe("2.40");
    expect(rowBefore.status).toBe("PREPARING");
  });

  it("recalculates the total only once the customer confirms removal", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [
      { productId: chocolateId, quantity: 2 },
      { productId: foilId, quantity: 1 },
    ]);
    await driveTo(order.id, "PREPARING");

    const foilItem = order.items.find((i: { productId: string }) => i.productId === foilId);
    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${foilItem.id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    // The customer sees the out-of-stock item and what the new total would be.
    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.hasUnavailableItems).toBe(true);
    expect(seen.body.unavailableItemNames).toEqual(["Aluminium Foil Roll"]);
    expect(seen.body.totalPrice).toBe("2.40");
    expect(seen.body.revisedTotal).toBe("1.50");

    // They accept -> NOW the total changes.
    const accepted = await http()
      .post(`/api/orders/${order.id}/accept-changes`)
      .set(customer)
      .expect(201);

    expect(accepted.body.totalPrice).toBe("1.50");
    expect(accepted.body.hasUnavailableItems).toBe(false);
    expect(accepted.body.items).toHaveLength(1);
    expect(accepted.body.status).toBe("PREPARING");

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { orderItems: true },
    });
    expect(row.totalPrice.toFixed(2)).toBe("1.50");
    expect(row.orderItems).toHaveLength(1);
    expect(row.orderItems[0].productId).toBe(chocolateId);
  });

  it("keeps the surviving items' original snapshotted prices after recalculation", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [
      { productId: chocolateId, quantity: 2 },
      { productId: foilId, quantity: 1 },
    ]);
    await driveTo(order.id, "PREPARING");

    const foilItem = order.items.find((i: { productId: string }) => i.productId === foilId);
    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${foilItem.id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    // The shop reprices chocolate while the customer decides.
    const original = await prisma.product.findUniqueOrThrow({ where: { id: chocolateId } });
    await prisma.product.update({ where: { id: chocolateId }, data: { price: "5.00" } });

    try {
      const accepted = await http()
        .post(`/api/orders/${order.id}/accept-changes`)
        .set(customer)
        .expect(201);

      // Recalculation must use the SNAPSHOT (0.50), not the new price (5.00).
      expect(accepted.body.items[0].priceAtOrder).toBe("0.50");
      expect(accepted.body.totalPrice).toBe("1.50");
    } finally {
      await prisma.product.update({ where: { id: chocolateId }, data: { price: original.price } });
    }
  });

  it("cancels the order when every item turns out to be unavailable", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: soapId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${order.items[0].id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    const accepted = await http()
      .post(`/api/orders/${order.id}/accept-changes`)
      .set(customer)
      .expect(201);

    // Nothing left to deliver: cancelled by the SYSTEM, not billed for delivery.
    expect(accepted.body.status).toBe("CANCELLED");
    expect(accepted.body.cancelledBy).toBe("SYSTEM");
    expect(accepted.body.cancellationReason).toMatch(/out of stock/i);
  });

  it("notifies the customer when an item is flagged out of stock", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: foilId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${order.items[0].id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    const events = notifications.eventsFor(order.id);
    const event = events.find((e) => e.type === "order.items_unavailable");
    expect(event).toBeDefined();
    expect(event!.detail).toContain("Aluminium Foil Roll");
  });

  it("lets the shop put an item back to confirmed if it turns up", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: foilId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${order.items[0].id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(200);

    const restored = await http()
      .patch(`/api/merchant/orders/${order.id}/items/${order.items[0].id}`)
      .set(merchantAuth)
      .send({ status: "CONFIRMED" })
      .expect(200);

    expect(restored.body.hasUnavailableItems).toBe(false);
    expect(restored.body.revisedTotal).toBe("1.40");
  });

  it("refuses to accept changes when nothing is out of stock", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().post(`/api/orders/${order.id}/accept-changes`).set(customer).expect(409);
  });
});

describe("Customer cancellation rules", () => {
  it("cancels freely while PENDING", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    const policy = await http()
      .get(`/api/orders/${order.id}/cancel-policy`)
      .set(customer)
      .expect(200);
    expect(policy.body.canCancel).toBe(true);
    expect(policy.body.requiresWarning).toBe(false);

    const cancelled = await http()
      .post(`/api/orders/${order.id}/cancel`)
      .set(customer)
      .send({})
      .expect(201);

    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.cancelledBy).toBe("CUSTOMER");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledBy).toBe("CUSTOMER");
  });

  it("allows cancelling during PREPARING but flags that a warning is needed", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    const policy = await http()
      .get(`/api/orders/${order.id}/cancel-policy`)
      .set(customer)
      .expect(200);
    expect(policy.body.canCancel).toBe(true);
    // The app must warn the customer first — the shop is already picking.
    expect(policy.body.requiresWarning).toBe(true);

    const cancelled = await http()
      .post(`/api/orders/${order.id}/cancel`)
      .set(customer)
      .send({ reason: "Changed my mind" })
      .expect(201);

    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.cancellationReason).toBe("Changed my mind");
  });

  it("BLOCKS cancellation once the order is out for delivery", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "DELIVERING");

    const policy = await http()
      .get(`/api/orders/${order.id}/cancel-policy`)
      .set(customer)
      .expect(200);
    expect(policy.body.canCancel).toBe(false);
    expect(policy.body.reason).toMatch(/on its way/i);

    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({}).expect(409);

    // And it really is untouched.
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("DELIVERING");
    expect(row.cancelledBy).toBeNull();
  });

  it("cannot cancel an already delivered order", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });

    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({}).expect(409);
  });

  it("cannot cancel someone else's order", async () => {
    const mine = await newCustomer();
    const order = await placeOrder(mine, [{ productId: chocolateId, quantity: 1 }]);
    const stranger = await newCustomer();

    await http().post(`/api/orders/${order.id}/cancel`).set(stranger).send({}).expect(404);
  });
});

describe("Merchant cancellation rules", () => {
  it("requires a reason — an empty or missing one is refused", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    await http().post(`/api/merchant/orders/${order.id}/cancel`).set(merchantAuth).send({}).expect(400);
    await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "" })
      .expect(400);
    await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "  " })
      .expect(400);

    // Still alive — none of those attempts cancelled it.
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("PREPARING");
  });

  it("cancels during PREPARING with a reason, and notifies the customer immediately", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "PREPARING");

    const cancelled = await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "We are closing early today" })
      .expect(201);

    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.cancelledBy).toBe("MERCHANT");
    expect(cancelled.body.cancellationReason).toBe("We are closing early today");

    // The spec requires an immediate notification event.
    const event = notifications.eventsFor(order.id).find((e) => e.type === "order.cancelled_by_merchant");
    expect(event).toBeDefined();
    expect(event!.detail).toBe("We are closing early today");

    // And the customer can read the reason.
    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.status).toBe("CANCELLED");
    expect(seen.body.cancellationReason).toBe("We are closing early today");
  });

  it("cannot cancel a PENDING order — it must be confirmed first", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    const res = await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "Out of everything" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/confirm the order/i);
  });

  it("cannot cancel once the order is out for delivery", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "DELIVERING");

    await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "Too late" })
      .expect(409);
  });

  it("cannot change items once the order is out for delivery", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await driveTo(order.id, "DELIVERING");

    await http()
      .patch(`/api/merchant/orders/${order.id}/items/${order.items[0].id}`)
      .set(merchantAuth)
      .send({ status: "UNAVAILABLE" })
      .expect(409);
  });
});

describe("Order handling access control", () => {
  it("blocks a customer from the merchant order endpoints", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().get("/api/merchant/orders").set(customer).expect(403);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(customer).expect(403);
    await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(customer)
      .send({ reason: "nope" })
      .expect(403);
  });

  it("blocks a merchant from the customer cancel endpoint", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);

    await http().post(`/api/orders/${order.id}/cancel`).set(merchantAuth).send({}).expect(403);
  });

  it("requires a token", async () => {
    await http().get("/api/merchant/orders").expect(401);
  });
});
