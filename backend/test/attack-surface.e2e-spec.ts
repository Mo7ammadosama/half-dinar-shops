/**
 * Phase 9 — attacking the surface the red-team suite did not cover.
 *
 * red-team.e2e-spec.ts fires cross-role and privilege-escalation attacks. This
 * file fires the OTHER classes the Phase 9 brief named and that were not yet
 * exercised end-to-end:
 *
 *   - hostile NUMERIC input (overflow, non-finite, too many decimals, over-cap),
 *   - oversized payloads (huge strings, too-many-line orders),
 *   - OTP replay / supersession / expiry,
 *   - invalid ORDER STATE TRANSITIONS fired straight at the API, bypassing the
 *     UI — because a UI that refuses something is not the same as the server
 *     refusing it.
 *
 * Every test asserts the SECURE outcome (400 / 409 / 401). A failure here means
 * an attack now succeeds, not merely that an assertion tripped.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
let http: () => ReturnType<typeof request>;

const createdPhones: string[] = [];

let pilotShopId: string;
let merchantAuth: { Authorization: string };
let categoryId: string;
let chocolateId: string;

async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code: otp.body.devCode })
    .expect(200);
  return verified.body.accessToken;
}

/** A fresh customer from the reserved test range (+962780000XXX). */
async function newCustomer() {
  const phoneNumber = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phoneNumber);
  return { Authorization: `Bearer ${await login(phoneNumber)}` };
}

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

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  merchantAuth = { Authorization: `Bearer ${await login("+962791234567")}` };

  const pilot = await prisma.merchant.findFirstOrThrow({
    where: { shopName: "Al-Nus Dinar Shop" },
    select: { id: true },
  });
  pilotShopId = pilot.id;

  categoryId = (await prisma.category.findFirstOrThrow({ select: { id: true } })).id;
  chocolateId = (
    await prisma.product.findFirstOrThrow({
      where: { name: "Chocolate Bar 30g", merchantId: pilotShopId },
    })
  ).id;
});

afterAll(async () => {
  // Nothing here should have persisted (every write is meant to be rejected),
  // but clean defensively: test customers' orders, and any product a leak let
  // through under the [ATK] marker.
  const testCustomers = await prisma.user.findMany({
    where: { phoneNumber: { startsWith: "+962780000" } },
    select: { id: true },
  });
  const ids = testCustomers.map((c) => c.id);
  await prisma.orderItem.deleteMany({ where: { order: { customerId: { in: ids } } } });
  await prisma.order.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.product.deleteMany({
    where: { merchantId: pilotShopId, name: { startsWith: "[ATK]" } },
  });
  await app.close();
});

// ── Hostile numeric input: product create (merchant) ─────────────────────────

describe("hostile numeric input — product create", () => {
  const create = (price: unknown, name = "[ATK] Item") =>
    http().post("/api/products").set(merchantAuth).send({ name, price, categoryId });

  it("rejects a price above the sane maximum (1000 JOD)", async () => {
    await create(1500).expect(400);
  });

  it("rejects a price with more than two decimal places", async () => {
    await create(0.001).expect(400);
  });

  it("rejects a non-finite price sent as 'Infinity'", async () => {
    // class-transformer coerces the string; @IsNumber defaults reject infinity.
    await create("Infinity").expect(400);
  });

  it("rejects a NaN price", async () => {
    await create("NaN").expect(400);
  });

  it("rejects an absurdly large finite price (1e308)", async () => {
    await create(1e308).expect(400);
  });

  it("rejects a negative price expressed with decimals (-0.01)", async () => {
    await create(-0.01).expect(400);
  });

  it("rejects an oversized product name (>160 chars)", async () => {
    await create(0.5, "[ATK] " + "x".repeat(200)).expect(400);
  });

  it("leaves nothing behind — no [ATK] product was created by any rejected write", async () => {
    const leaked = await prisma.product.count({
      where: { merchantId: pilotShopId, name: { startsWith: "[ATK]" } },
    });
    expect(leaked).toBe(0);
  });
});

// ── Hostile numeric input: order placement (customer) ────────────────────────

describe("hostile numeric input — order placement", () => {
  it("rejects a quantity above the per-item cap (100 > 99)", async () => {
    const auth = await newCustomer();
    await http()
      .post("/api/orders")
      .set(auth)
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 100 }] })
      .expect(400);
  });

  it("rejects a fractional quantity (1.5)", async () => {
    const auth = await newCustomer();
    await http()
      .post("/api/orders")
      .set(auth)
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: 1.5 }] })
      .expect(400);
  });

  it("rejects a non-finite quantity ('Infinity')", async () => {
    const auth = await newCustomer();
    await http()
      .post("/api/orders")
      .set(auth)
      .send({ shopId: pilotShopId, items: [{ productId: chocolateId, quantity: "Infinity" }] })
      .expect(400);
  });

  it("rejects an order with more distinct lines than the cap (51 > 50)", async () => {
    const auth = await newCustomer();
    const items = Array.from({ length: 51 }, () => ({ productId: chocolateId, quantity: 1 }));
    await http().post("/api/orders").set(auth).send({ shopId: pilotShopId, items }).expect(400);
  });
});

// ── Oversized uploads (DoS surface) ──────────────────────────────────────────

describe("oversized uploads are rejected (DoS surface)", () => {
  // MAX_UPLOAD_BYTES defaults to 5 MB; 8 MB is safely over it.
  const tooBig = () => Buffer.alloc(8 * 1024 * 1024, 0x41);

  it("refuses an over-limit product image upload", async () => {
    const res = await http()
      .post("/api/uploads/product-image")
      .set(merchantAuth)
      .attach("file", tooBig(), "huge.png");
    // multer's LIMIT_FILE_SIZE surfaces as a client error, never a 5xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses an over-limit AI-vision upload (same guard, not a weaker copy)", async () => {
    const res = await http()
      .post("/api/products/suggest-from-photo")
      .set(merchantAuth)
      .attach("file", tooBig(), "huge.png");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ── Injection patterns ───────────────────────────────────────────────────────

describe("injection patterns are treated as literal data, not code", () => {
  const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE products;--", "%27%20OR%201=1", "\" OR \"\"=\""];

  it("SQL-ish search strings return normally and never damage the table", async () => {
    for (const search of PAYLOADS) {
      // Prisma parameterizes `contains`, so these are matched as literal text.
      const res = await http()
        .get(`/api/products?search=${encodeURIComponent(search)}`)
        .set(merchantAuth)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true); // a normal (usually empty) result set
    }

    // The table is intact and the catalogue is untouched — no DROP ran.
    const count = await prisma.product.count({ where: { merchantId: pilotShopId } });
    expect(count).toBe(20);
  });

  it("stores a script-tag product name as inert text (no injection, exact round-trip)", async () => {
    const name = "[ATK] <script>alert(1)</script>";
    const created = await http()
      .post("/api/products")
      .set(merchantAuth)
      .send({ name, price: 0.5, categoryId })
      .expect(201);

    // Stored and returned verbatim — Prisma escaped it; it was never executed.
    // (XSS at render time is a separate concern; both clients are React, which
    // escapes text nodes by default.)
    const fetched = await http()
      .get(`/api/products/${created.body.id}`)
      .set(merchantAuth)
      .expect(200);
    expect(fetched.body.name).toBe(name);

    await prisma.product.delete({ where: { id: created.body.id } });
  });
});

// ── OTP replay / supersession / expiry ───────────────────────────────────────

describe("OTP replay, supersession and expiry", () => {
  it("invalidates an earlier code the moment a newer one is requested", async () => {
    // An attacker who saw the first SMS must not be able to use it after the
    // customer requested a fresh code. auth.service invalidates outstanding
    // codes on each request; this proves it end-to-end.
    const phoneNumber = uniqueTestPhone();
    const first = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
    const second = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);

    // The stale first code is now dead.
    await http()
      .post("/api/auth/otp/verify")
      .send({ phoneNumber, code: first.body.devCode })
      .expect(401);

    // Only the newest one works.
    await http()
      .post("/api/auth/otp/verify")
      .send({ phoneNumber, code: second.body.devCode })
      .expect(200);
  });

  it("refuses an expired code even on the very first attempt", async () => {
    const phoneNumber = uniqueTestPhone();
    const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);

    // Force the outstanding code into the past — the same effect as waiting out
    // the TTL, without making the test sleep.
    const user = await prisma.user.findUniqueOrThrow({
      where: { phoneNumber },
      select: { id: true },
    });
    await prisma.otpCode.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await http()
      .post("/api/auth/otp/verify")
      .send({ phoneNumber, code: otp.body.devCode })
      .expect(401);
  });
});

// ── Invalid state transitions fired directly at the API ──────────────────────

describe("invalid order-state transitions (direct API, bypassing the UI)", () => {
  it("cannot confirm an order that is already confirmed", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
    // Second confirm is a no-op transition CONFIRMED -> CONFIRMED — refused.
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(409);
  });

  it("cannot confirm an order that has already been delivered", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(409);
  });

  it("cannot start preparing an unconfirmed (pending) order — no skipping confirm", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await http()
      .post(`/api/merchant/orders/${order.id}/start-preparing`)
      .set(merchantAuth)
      .expect(409);
  });

  it("cannot assign a driver before the order is being prepared", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await http().post(`/api/merchant/orders/${order.id}/confirm`).set(merchantAuth).expect(201);
    // Order is CONFIRMED, not PREPARING — a driver cannot be assigned yet.
    await http()
      .post(`/api/merchant/orders/${order.id}/delivery`)
      .set(merchantAuth)
      .send({ captainName: "Mallory", captainPhone: "0791122334" })
      .expect(409);
  });

  it("cannot accept out-of-stock removals when there are none", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await http()
      .post(`/api/orders/${order.id}/accept-changes`)
      .set(customer)
      .expect(409);
  });

  it("cannot review an order that has not been delivered", async () => {
    const customer = await newCustomer();
    const order = await placeOrder(customer, [{ productId: chocolateId, quantity: 1 }]);
    await http()
      .post(`/api/orders/${order.id}/review`)
      .set(customer)
      .send({ rating: 5 })
      .expect(409);
  });
});

/** A unique reserved-range phone, tracked for cleanup. */
function uniqueTestPhone(): string {
  const phone = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  createdPhones.push(phone);
  return phone;
}
