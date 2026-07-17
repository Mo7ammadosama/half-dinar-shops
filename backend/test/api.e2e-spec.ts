/**
 * Phase 2 end-to-end API tests.
 *
 * These drive the real HTTP surface of the real application against the real
 * database — registration, OTP login, product CRUD, role enforcement and
 * uploads. Rate limiting is disabled here and covered by throttle.e2e-spec.ts.
 *
 * Run with: npm run test:e2e
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, REAL_PNG, uniquePhone } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
// `request(app)` returns TestAgent; ReturnType keeps this correct across
// supertest versions rather than naming a type that has since changed.
let http: () => ReturnType<typeof request>;

/** Phone numbers created by this suite, removed in afterAll. */
const createdPhones: string[] = [];

/** Registers a shop and logs in, returning a ready-to-use merchant token. */
async function createMerchant(shopName: string) {
  const phoneNumber = uniquePhone();
  createdPhones.push(phoneNumber);

  const registration = await http()
    .post("/api/merchants/register")
    .send({
      phoneNumber,
      shopName,
      locationLat: 31.95,
      locationLng: 35.93,
      openingHours: "08:00-23:00",
    })
    .expect(201);

  const token = await login(phoneNumber);
  return { phoneNumber, token, merchantId: registration.body.merchant.id };
}

/** Runs the OTP request/verify pair and returns the access token. */
async function login(phoneNumber: string): Promise<string> {
  const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);

  // Only present because EXPOSE_OTP_IN_RESPONSE is on outside production.
  const code = otp.body.devCode as string;
  expect(code).toMatch(/^\d{6}$/);

  const verified = await http()
    .post("/api/auth/otp/verify")
    .send({ phoneNumber, code })
    .expect(200);

  return verified.body.accessToken;
}

/** Logs in as the seeded customer. */
async function customerToken(): Promise<string> {
  return login("+962791111111");
}

let categoryId: string;

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  http = () => request(app.getHttpServer());

  const category = await prisma.category.findFirstOrThrow({
    where: { name: "Drinks" },
    select: { id: true },
  });
  categoryId = category.id;
});

afterAll(async () => {
  // Products cascade with their merchant, which cascades with its user.
  await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  await app.close();
});

describe("Merchant registration", () => {
  it("registers a shop with PENDING status awaiting admin approval", async () => {
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);

    const res = await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber,
        shopName: "Registration Test Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(201);

    expect(res.body.merchant.status).toBe("PENDING");
    expect(res.body.merchant.shopName).toBe("Registration Test Shop");
  });

  it("normalizes a locally-formatted phone number to E.164", async () => {
    const local = `079${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    const expected = `+962${local.slice(1)}`;
    createdPhones.push(expected);

    await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber: local,
        shopName: "Normalization Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { phoneNumber: expected } });
    expect(user).not.toBeNull();
    expect(user!.role).toBe("MERCHANT");
  });

  it("rejects a phone number that is not a Jordanian mobile", async () => {
    const res = await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber: "+14155552671",
        shopName: "Foreign Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(400);

    expect(JSON.stringify(res.body.message)).toContain("Jordanian mobile");
  });

  it("rejects a second shop on the same phone number", async () => {
    const merchant = await createMerchant("First Shop");

    await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber: merchant.phoneNumber,
        shopName: "Duplicate Shop",
        locationLat: 31.95,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(409);
  });

  it("rejects invalid coordinates", async () => {
    await http()
      .post("/api/merchants/register")
      .send({
        phoneNumber: uniquePhone(),
        shopName: "Bad Coords",
        locationLat: 999,
        locationLng: 35.93,
        openingHours: "08:00-23:00",
      })
      .expect(400);
  });
});

describe("OTP login", () => {
  it("issues a working token for a correct code", async () => {
    const { token } = await createMerchant("Login Shop");

    const me = await http()
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(me.body.role).toBe("MERCHANT");
  });

  it("rejects a wrong code", async () => {
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);

    await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
    await http()
      .post("/api/auth/otp/verify")
      .send({ phoneNumber, code: "000000" })
      .expect(401);
  });

  it("never stores the OTP in plaintext", async () => {
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);

    const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
    const code = otp.body.devCode as string;

    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber } });
    const stored = await prisma.otpCode.findFirstOrThrow({ where: { userId: user.id } });

    expect(stored.codeHash).not.toContain(code);
    expect(stored.codeHash.startsWith("$argon2")).toBe(true);
  });

  it("burns the code after a single successful use", async () => {
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);

    const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
    const code = otp.body.devCode as string;

    await http().post("/api/auth/otp/verify").send({ phoneNumber, code }).expect(200);
    // Replaying the same code must fail.
    await http().post("/api/auth/otp/verify").send({ phoneNumber, code }).expect(401);
  });

  it("stops accepting a code after too many wrong attempts", async () => {
    const phoneNumber = uniquePhone();
    createdPhones.push(phoneNumber);

    const otp = await http().post("/api/auth/otp/request").send({ phoneNumber }).expect(200);
    const code = otp.body.devCode as string;

    // OTP_MAX_ATTEMPTS is 5.
    for (let i = 0; i < 5; i++) {
      await http().post("/api/auth/otp/verify").send({ phoneNumber, code: "111111" }).expect(401);
    }

    // Even the *correct* code is now refused — the code is locked, not just guessed.
    await http().post("/api/auth/otp/verify").send({ phoneNumber, code }).expect(401);
  });

  it("rejects a malformed code without touching the database", async () => {
    await http()
      .post("/api/auth/otp/verify")
      .send({ phoneNumber: "+962791111111", code: "abc" })
      .expect(400);
  });
});

describe("Authentication and role enforcement", () => {
  it("refuses protected endpoints without a token", async () => {
    await http().get("/api/products").expect(401);
    await http().get("/api/merchants/me").expect(401);
    await http().get("/api/categories").expect(401);
  });

  it("refuses a garbage token", async () => {
    await http()
      .get("/api/products")
      .set("Authorization", "Bearer not.a.real.token")
      .expect(401);
  });

  it("blocks a customer from every merchant endpoint", async () => {
    const token = await customerToken();
    const auth = { Authorization: `Bearer ${token}` };

    await http().get("/api/products").set(auth).expect(403);
    await http().post("/api/products").set(auth).send({ name: "x", price: 1, categoryId }).expect(403);
    await http().get("/api/merchants/me").set(auth).expect(403);
    await http().post("/api/uploads/product-image").set(auth).expect(403);
  });

  it("lets a customer read the shared category list", async () => {
    const token = await customerToken();
    await http().get("/api/categories").set("Authorization", `Bearer ${token}`).expect(200);
  });
});

describe("Product CRUD", () => {
  it("creates, reads, updates and deletes a product", async () => {
    const { token } = await createMerchant("CRUD Shop");
    const auth = { Authorization: `Bearer ${token}` };

    const created = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Mango Juice 250ml", price: 0.5, categoryId })
      .expect(201);

    expect(created.body.price).toBe("0.50");
    expect(created.body.isAvailable).toBe(true);
    expect(created.body.categoryPath).toBe("Food & Snacks > Drinks");
    const id = created.body.id;

    const read = await http().get(`/api/products/${id}`).set(auth).expect(200);
    expect(read.body.name).toBe("Mango Juice 250ml");

    const updated = await http()
      .patch(`/api/products/${id}`)
      .set(auth)
      .send({ name: "Mango Juice 300ml", price: 0.75 })
      .expect(200);
    expect(updated.body.name).toBe("Mango Juice 300ml");
    expect(updated.body.price).toBe("0.75");

    await http().delete(`/api/products/${id}`).set(auth).expect(200);
    await http().get(`/api/products/${id}`).set(auth).expect(404);
  });

  it("toggles availability", async () => {
    const { token } = await createMerchant("Toggle Shop");
    const auth = { Authorization: `Bearer ${token}` };

    const created = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Toggle Item", price: 0.5, categoryId })
      .expect(201);

    const off = await http()
      .patch(`/api/products/${created.body.id}/availability`)
      .set(auth)
      .send({ isAvailable: false })
      .expect(200);
    expect(off.body.isAvailable).toBe(false);

    const on = await http()
      .patch(`/api/products/${created.body.id}/availability`)
      .set(auth)
      .send({ isAvailable: true })
      .expect(200);
    expect(on.body.isAvailable).toBe(true);
  });

  it("stores 0.50 exactly, with no floating-point drift", async () => {
    const { token } = await createMerchant("Precision Shop");
    const auth = { Authorization: `Bearer ${token}` };

    const created = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Half Dinar Item", price: 0.5, categoryId })
      .expect(201);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.price.toFixed(2)).toBe("0.50");
  });

  it("supports search and category filters", async () => {
    const { token } = await createMerchant("Filter Shop");
    const auth = { Authorization: `Bearer ${token}` };

    await http().post("/api/products").set(auth).send({ name: "Apple Juice", price: 0.5, categoryId }).expect(201);
    await http().post("/api/products").set(auth).send({ name: "Banana Milk", price: 0.5, categoryId }).expect(201);

    const search = await http().get("/api/products?search=apple").set(auth).expect(200);
    expect(search.body).toHaveLength(1);
    expect(search.body[0].name).toBe("Apple Juice");

    const byCategory = await http().get(`/api/products?categoryId=${categoryId}`).set(auth).expect(200);
    expect(byCategory.body).toHaveLength(2);
  });
});

describe("Input validation", () => {
  let auth: { Authorization: string };

  beforeAll(async () => {
    const { token } = await createMerchant("Validation Shop");
    auth = { Authorization: `Bearer ${token}` };
  });

  it("rejects a negative price", async () => {
    const res = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Negative", price: -1, categoryId })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain("price cannot be negative");
  });

  it("rejects more than two decimal places on price", async () => {
    await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Too Precise", price: 0.555, categoryId })
      .expect(400);
  });

  it("rejects an unknown field rather than silently ignoring it", async () => {
    const res = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Smuggler", price: 0.5, categoryId, merchantId: "00000000-0000-0000-0000-000000000000" })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain("merchantId should not exist");
  });

  it("rejects a category that does not exist", async () => {
    await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Orphan", price: 0.5, categoryId: "00000000-0000-0000-0000-000000000000" })
      .expect(400);
  });

  it("rejects a malformed product id", async () => {
    await http().get("/api/products/not-a-uuid").set(auth).expect(400);
  });

  it("rejects an empty name", async () => {
    await http().post("/api/products").set(auth).send({ name: "", price: 0.5, categoryId }).expect(400);
  });
});

describe("Shop isolation", () => {
  it("never shows one shop the products of another", async () => {
    const shopA = await createMerchant("Isolation Shop A");
    const shopB = await createMerchant("Isolation Shop B");
    const authA = { Authorization: `Bearer ${shopA.token}` };
    const authB = { Authorization: `Bearer ${shopB.token}` };

    const productA = await http()
      .post("/api/products")
      .set(authA)
      .send({ name: "Shop A Secret Item", price: 0.5, categoryId })
      .expect(201);

    // B's list must not contain A's product.
    const listB = await http().get("/api/products").set(authB).expect(200);
    expect(listB.body.map((p: { name: string }) => p.name)).not.toContain("Shop A Secret Item");

    // Nor may B read, modify, or delete it by guessing the id.
    await http().get(`/api/products/${productA.body.id}`).set(authB).expect(404);
    await http().patch(`/api/products/${productA.body.id}`).set(authB).send({ price: 9.99 }).expect(404);
    await http().delete(`/api/products/${productA.body.id}`).set(authB).expect(404);

    // And A's product is untouched.
    const stillA = await http().get(`/api/products/${productA.body.id}`).set(authA).expect(200);
    expect(stillA.body.price).toBe("0.50");
  });

  it("does not leak the seeded pilot shop's stock to a new merchant", async () => {
    const { token } = await createMerchant("Fresh Shop");
    const list = await http().get("/api/products").set("Authorization", `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(0);
  });
});

describe("Image upload", () => {
  it("accepts a real PNG and serves it back", async () => {
    const { token } = await createMerchant("Upload Shop");
    const auth = { Authorization: `Bearer ${token}` };

    const res = await http()
      .post("/api/uploads/product-image")
      .set(auth)
      .attach("file", REAL_PNG, "photo.png")
      .expect(201);

    expect(res.body.imageUrl).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);
    expect(res.body.mimeType).toBe("image/png");
  });

  it("rejects a non-image disguised with an image filename and mimetype", async () => {
    const { token } = await createMerchant("Fake Upload Shop");

    // Content is what matters — the name and declared type are both lies.
    await http()
      .post("/api/uploads/product-image")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("#!/bin/sh\nrm -rf /"), {
        filename: "innocent.png",
        contentType: "image/png",
      })
      .expect(400);
  });

  it("attaches an uploaded image to a product", async () => {
    const { token } = await createMerchant("Photo Shop");
    const auth = { Authorization: `Bearer ${token}` };

    const upload = await http()
      .post("/api/uploads/product-image")
      .set(auth)
      .attach("file", REAL_PNG, "photo.png")
      .expect(201);

    const product = await http()
      .post("/api/products")
      .set(auth)
      .send({ name: "Item With Photo", price: 0.5, categoryId, imageUrl: upload.body.imageUrl })
      .expect(201);

    expect(product.body.imageUrl).toBe(upload.body.imageUrl);
  });
});
