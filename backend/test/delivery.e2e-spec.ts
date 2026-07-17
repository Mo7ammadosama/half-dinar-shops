/**
 * Phase 6 — manual delivery tracking.
 *
 * There is no captain app, so a human moves each delivery along. Under test:
 *
 *   - The captain's name and FULL phone number reach the customer (no masking).
 *   - The order status follows the delivery status and cannot contradict it.
 *   - Cancellation becomes blocked exactly when the goods leave the shop.
 *   - A failed delivery cancels the order and says why.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
// `request(app)` returns TestAgent; ReturnType keeps this correct across
// supertest versions rather than naming a type that has since changed.
let http: () => ReturnType<typeof request>;

const createdPhones: string[] = [];

let pilotShopId: string;
let merchantAuth: { Authorization: string };
let chocolateId: string;

const CAPTAIN = { captainName: "Omar Al-Zoubi", captainPhone: "0791122334" };
/** The number as it is stored and shown — normalized, never masked. */
const CAPTAIN_PHONE_E164 = "+962791122334";

async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

async function newCustomer() {
  const phoneNumber = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phoneNumber);
  return { Authorization: `Bearer ${await login(phoneNumber)}` };
}

/** Places an order and drives it to PREPARING, ready for a driver. */
async function orderReadyForDelivery(customer: { Authorization: string }) {
  const order = (
    await http()
      .post("/api/orders")
      .set(customer)
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 1 }] })
      .expect(201)
  ).body;

  await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
  await http()
    .post(`/api/merchant/orders/${order.id}/start-preparing`)
    .set(merchantAuth)
    .expect(201);

  return order;
}

/** Assigns the test captain. */
async function assign(orderId: string) {
  return http()
    .post(`/api/merchant/orders/${orderId}/delivery`)
    .set(merchantAuth)
    .send(CAPTAIN)
    .expect(201);
}

/** Moves the delivery to a status. */
async function move(orderId: string, status: string, note?: string) {
  return http()
    .patch(`/api/merchant/orders/${orderId}/delivery`)
    .set(merchantAuth)
    .send(note ? { status, note } : { status });
}

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  merchantAuth = { Authorization: `Bearer ${await login("+962791234567")}` };

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;

  chocolateId = (
    await prisma.product.findFirstOrThrow({
      where: { name: "Chocolate Bar 30g", merchantId: pilotShopId },
    })
  ).id;
});

afterAll(async () => {
  const testCustomers = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: "+962780000" } },
    select: { id: true },
  });
  await prisma.order.deleteMany({ where: { customerId: { in: testCustomers.map((c) => c.id) } } });
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await app.close();
});

describe("Walking an order through every delivery status", () => {
  it("goes assigned -> picked up -> on way -> delivered, with the order following", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    // ASSIGNED: a driver is named, but the bag has not left, so the order is
    // still PREPARING and the customer can still cancel.
    const assigned = await assign(order.id);
    expect(assigned.body.delivery.status).toBe("ASSIGNED");
    expect(assigned.body.status).toBe("PREPARING");

    const seenAssigned = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seenAssigned.body.delivery.statusLabel).toBe("A driver has been assigned");
    expect(seenAssigned.body.canCancel).toBe(true);

    // PICKED_UP: the goods are out -> the order becomes DELIVERING.
    const pickedUp = await move(order.id, "PICKED_UP");
    expect(pickedUp.status).toBe(200);
    expect(pickedUp.body.delivery.status).toBe("PICKED_UP");
    expect(pickedUp.body.status).toBe("DELIVERING");

    // ON_WAY
    const onWay = await move(order.id, "ON_WAY");
    expect(onWay.body.delivery.status).toBe("ON_WAY");
    expect(onWay.body.status).toBe("DELIVERING");

    const seenOnWay = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seenOnWay.body.delivery.statusLabel).toBe("Your order is on its way");
    expect(seenOnWay.body.status).toBe("DELIVERING");

    // DELIVERED
    const delivered = await move(order.id, "DELIVERED");
    expect(delivered.body.delivery.status).toBe("DELIVERED");
    expect(delivered.body.status).toBe("DELIVERED");
    expect(delivered.body.delivery.deliveredAt).not.toBeNull();

    // And the database agrees.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { delivery: true },
    });
    expect(row.status).toBe("DELIVERED");
    expect(row.delivery!.status).toBe("DELIVERED");
    expect(row.delivery!.deliveredAt).toBeInstanceOf(Date);
  });

  it("stamps delivered_at only when actually delivered", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);

    await move(order.id, "PICKED_UP");
    let row = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.deliveredAt).toBeNull();

    await move(order.id, "DELIVERED");
    row = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.deliveredAt).not.toBeNull();
  });
});

describe("The captain's details reach the customer unmasked", () => {
  it("shows the customer the driver's name and full phone number", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);
    await move(order.id, "PICKED_UP");
    await move(order.id, "ON_WAY");

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);

    expect(seen.body.delivery.captainName).toBe("Omar Al-Zoubi");
    // The full number, exactly as stored — the spec asks for no masking.
    expect(seen.body.delivery.captainPhone).toBe(CAPTAIN_PHONE_E164);
    expect(seen.body.delivery.captainPhone).not.toMatch(/\*/);
  });

  it("normalizes a locally-typed captain number", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    // The shop types "0791122334"; it is stored E.164.
    await assign(order.id);

    const row = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.captainPhone).toBe(CAPTAIN_PHONE_E164);
  });

  it("rejects a captain phone number that is not a Jordanian mobile", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    const res = await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ captainName: "Someone", captainPhone: "+14155552671" });

    expect(res.status).toBe(400);
  });

  it("rejects an empty captain name", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ captainName: "", captainPhone: "0791122334" })
      .expect(400);
  });
});

describe("Delivery status rules", () => {
  it("refuses to assign a driver before the shop is picking", async () => {
    const customer = await newCustomer();
    const order = (
      await http()
        .post("/api/orders")
        .set(customer)
        .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 1 }] })
        .expect(201)
    ).body;

    // Still PENDING.
    const res = await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send(CAPTAIN);

    expect(res.status).toBe(409);
  });

  it("refuses to assign two drivers to one order", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    await assign(order.id);
    const second = await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ captainName: "Someone Else", captainPhone: "0799887766" });

    expect(second.status).toBe(409);
  });

  it("refuses to update a delivery that does not exist yet", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    const res = await move(order.id, "PICKED_UP");
    expect(res.status).toBe(404);
  });

  it("refuses to skip from assigned straight to delivered", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);

    // The driver must have collected it before it can arrive.
    const res = await move(order.id, "DELIVERED");
    expect(res.status).toBe(409);
  });

  it("refuses to move a delivered delivery again", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);
    await move(order.id, "PICKED_UP");
    await move(order.id, "DELIVERED");

    const res = await move(order.id, "ON_WAY");
    expect(res.status).toBe(409);
  });

  it("rejects a status that is not a real delivery status", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);

    const res = await http()
      .patch(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ status: "TELEPORTED" });

    expect(res.status).toBe(400);
  });
});

describe("Cancellation and delivery interact correctly", () => {
  it("still allows cancelling while a driver is only assigned", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);

    // The bag has not left, so the customer may still cancel (with a warning).
    const policy = await http()
      .get(`/api/orders/${order.id}/cancel-policy`)
      .set(customer)
      .expect(200);
    expect(policy.body.canCancel).toBe(true);
    expect(policy.body.requiresWarning).toBe(true);

    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({}).expect(201);
  });

  it("BLOCKS cancelling the moment the driver collects the order", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);
    await move(order.id, "PICKED_UP");

    const policy = await http()
      .get(`/api/orders/${order.id}/cancel-policy`)
      .set(customer)
      .expect(200);
    expect(policy.body.canCancel).toBe(false);
    expect(policy.body.reason).toMatch(/on its way/i);

    await http().post(`/api/orders/${order.id}/cancel`).set(customer).send({}).expect(409);
    // The merchant cannot either.
    await http()
      .post(`/api/merchant/orders/${order.id}/cancel`)
      .set(merchantAuth)
      .send({ reason: "changed my mind" })
      .expect(409);
  });
});

describe("A failed delivery", () => {
  it("cancels the order and tells the customer why", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);
    await move(order.id, "PICKED_UP");
    await move(order.id, "ON_WAY");

    const failed = await move(order.id, "FAILED", "Customer did not answer the door");
    expect(failed.status).toBe(200);
    expect(failed.body.delivery.status).toBe("FAILED");
    expect(failed.body.status).toBe("CANCELLED");

    const seen = await http().get(`/api/orders/${order.id}`).set(customer).expect(200);
    expect(seen.body.status).toBe("CANCELLED");
    expect(seen.body.cancelledBy).toBe("SYSTEM");
    expect(seen.body.cancellationReason).toBe("Delivery failed: Customer did not answer the door");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledBy).toBe("SYSTEM");
  });

  it("requires a note — a failed delivery cancels the order, so the reason is mandatory", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);
    await assign(order.id);
    await move(order.id, "PICKED_UP");

    const res = await move(order.id, "FAILED");
    expect(res.status).toBe(400);

    // Nothing changed.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { delivery: true },
    });
    expect(row.status).toBe("DELIVERING");
    expect(row.delivery!.status).toBe("PICKED_UP");
  });
});

describe("Delivery access control", () => {
  it("blocks a customer from assigning or moving a delivery", async () => {
    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(customer)
      .send(CAPTAIN)
      .expect(403);

    await assign(order.id);
    await http()
      .patch(`/api/merchant/orders/${order.id}/delivery`)
      .set(customer)
      .send({ status: "DELIVERED" })
      .expect(403);
  });

  it("blocks one shop from touching another shop's delivery", async () => {
    const phoneNumber = `+96277${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    createdPhones.push(phoneNumber);
    const otherUser = await prisma.user.create({
      data: { phoneNumber, role: "MERCHANT", otpVerified: true },
      select: { id: true },
    });
    await prisma.merchant.create({
      data: {
        userId: otherUser.id,
        shopName: "[TEST] Delivery Rival",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
        status: "APPROVED",
      },
    });
    const rivalAuth = { Authorization: `Bearer ${await login(phoneNumber)}` };

    const customer = await newCustomer();
    const order = await orderReadyForDelivery(customer);

    await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(rivalAuth)
      .send(CAPTAIN)
      .expect(404);
  });
});
