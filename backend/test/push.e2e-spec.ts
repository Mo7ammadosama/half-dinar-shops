import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { ConsolePushSender } from "../src/push/console-push.sender";
import { ExpoPushSender } from "../src/push/expo-push.sender";
import { createPushSender } from "../src/push/push.module";
import { PushService } from "../src/push/push.service";
import { PushSendError } from "../src/push/push.types";
import { NotificationsService } from "../src/orders/notifications.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, uniquePhone } from "./helpers";

/**
 * Customer push notifications (launch blocker B6).
 *
 * B6 is that the customer must have the app OPEN to learn anything — a
 * merchant cancels their order and nothing reaches a closed phone.
 *
 * HONEST SCOPE: a notification actually arriving on a real handset cannot be
 * verified here — it needs an Expo project and a physical device. What IS
 * verified is everything up to the push service's API boundary: that the right
 * message is produced for the right person, addressed to the right devices,
 * that a dead token is dropped, and — most importantly — that a push failure
 * can never break the order it is reporting on.
 */
describe("Customer push notifications (blocker B6)", () => {
  describe("provider selection", () => {
    const fakeConfig = (values: Record<string, string | undefined>) =>
      ({ get: (key: string) => values[key] }) as never;

    it("uses the console sender by default, and says so", () => {
      const sender = createPushSender(fakeConfig({}));
      expect(sender.name).toBe("console");
      // This is what lets the app tell the truth about B6 rather than looking
      // like it has push when it does not.
      expect(sender.deliversRealMessages).toBe(false);
    });

    it("switches to Expo on one env var — no code change", () => {
      const sender = createPushSender(fakeConfig({ PUSH_PROVIDER: "expo" }));
      expect(sender.name).toBe("expo");
      expect(sender.deliversRealMessages).toBe(true);
    });

    it("rejects an unknown provider name", () => {
      expect(() => createPushSender(fakeConfig({ PUSH_PROVIDER: "carrier-pigeon" }))).toThrow(
        /Unknown PUSH_PROVIDER/,
      );
    });
  });

  describe("the Expo sender", () => {
    const sender = () => new ExpoPushSender({ timeoutMs: 5_000 });
    const TOKEN = "ExponentPushToken[abc123]";

    afterEach(() => jest.restoreAllMocks());

    it("posts the notification to Expo with a high priority and a sound", async () => {
      const fetchMock = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { id: "receipt-1", status: "ok" } }), {
            status: 200,
          }),
        );

      const result = await sender().send({
        to: TOKEN,
        title: "Your order was cancelled",
        body: "The shop cancelled your order: closing early",
        data: { orderId: "order-1" },
      });

      expect(result).toEqual({ provider: "expo", messageId: "receipt-1" });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://exp.host/--/api/v2/push/send");

      const body = JSON.parse(init.body as string);
      expect(body.to).toBe(TOKEN);
      expect(body.title).toBe("Your order was cancelled");
      expect(body.data).toEqual({ orderId: "order-1" });
      // An order update is time-critical and the customer is waiting on it — a
      // silent, low-priority notification would defeat the point.
      expect(body.priority).toBe("high");
      expect(body.sound).toBe("default");
    });

    it("treats Expo's 200-with-status-error as a FAILURE, not a success", async () => {
      // The trap: Expo answers HTTP 200 and reports the real outcome per
      // message. Checking only response.ok would count an undelivered
      // notification as delivered.
      jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
          }),
          { status: 200 },
        ),
      );

      await expect(sender().send({ to: TOKEN, title: "t", body: "b" })).rejects.toThrow(
        PushSendError,
      );
    });

    it("reports a network failure rather than hanging", async () => {
      jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
      await expect(sender().send({ to: TOKEN, title: "t", body: "b" })).rejects.toThrow(
        /Could not reach the push service/,
      );
    });
  });

  describe("delivery to a customer's devices", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let push: PushService;
    let outbox: ConsolePushSender;
    let userId: string;

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      push = app.get(PushService);
      outbox = app.get(ConsolePushSender);

      userId = (
        await prisma.user.findFirstOrThrow({
          where: { phoneNumber: "+962791111111" },
          select: { id: true },
        })
      ).id;
    });

    afterEach(async () => {
      await prisma.deviceToken.deleteMany({ where: { userId } });
    });

    afterAll(async () => await app.close());

    it("reaches every device the customer is signed in on", async () => {
      // A customer with a phone and a tablet must be told on both.
      await push.registerDevice(userId, "ExponentPushToken[phone]", "android");
      await push.registerDevice(userId, "ExponentPushToken[tablet]", "ios");

      const delivered = await push.notifyUser(userId, { title: "Order confirmed", body: "..." });

      expect(delivered).toBe(2);
      expect(outbox.lastMessageTo("ExponentPushToken[phone]")).toBeDefined();
      expect(outbox.lastMessageTo("ExponentPushToken[tablet]")).toBeDefined();
    });

    it("moves a token to its new owner when a phone changes hands", async () => {
      // A shared family phone. The token must follow the new account, or the
      // previous owner keeps receiving a stranger's order updates.
      const other = await prisma.user.create({
        data: { phoneNumber: uniquePhone() },
        select: { id: true },
      });

      await push.registerDevice(userId, "ExponentPushToken[shared]", "android");
      await push.registerDevice(other.id, "ExponentPushToken[shared]", "android");

      expect(await push.notifyUser(userId, { title: "t", body: "b" })).toBe(0);
      expect(await push.notifyUser(other.id, { title: "t", body: "b" })).toBe(1);

      await prisma.deviceToken.deleteMany({ where: { userId: other.id } });
      await prisma.user.delete({ where: { id: other.id } });
    });

    it("does nothing (and does not throw) for a customer with no devices", async () => {
      await expect(push.notifyUser(userId, { title: "t", body: "b" })).resolves.toBe(0);
    });

    it("forgets a device on sign-out", async () => {
      await push.registerDevice(userId, "ExponentPushToken[gone]", "android");
      await push.unregisterOwnDevice(userId, "ExponentPushToken[gone]");

      expect(await push.notifyUser(userId, { title: "t", body: "b" })).toBe(0);
    });

    it("will NOT let one customer silence another's phone", async () => {
      // A push token is not a secret — it is handed to Expo and could leak.
      // Knowing one must not be enough to make a stranger miss their order.
      const victim = await prisma.user.create({
        data: { phoneNumber: uniquePhone() },
        select: { id: true },
      });
      await push.registerDevice(victim.id, "ExponentPushToken[victim]", "android");

      // An attacker who knows the token tries to unregister it.
      await push.unregisterOwnDevice(userId, "ExponentPushToken[victim]");

      // Still reachable.
      expect(await push.notifyUser(victim.id, { title: "t", body: "b" })).toBe(1);

      await prisma.deviceToken.deleteMany({ where: { userId: victim.id } });
      await prisma.user.delete({ where: { id: victim.id } });
    });
  });

  describe("the device endpoints", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let http: TestAgent;
    let token: string;
    let userId: string;

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      http = request(app.getHttpServer());

      const phone = uniquePhone().replace("+962", "0");
      const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });
      token = verify.body.accessToken;
      userId = verify.body.user.id;
    });

    afterAll(async () => {
      await prisma.deviceToken.deleteMany({ where: { userId } });
      await app.close();
    });

    it("registers the caller's device", async () => {
      await http
        .post("/api/auth/devices")
        .set("Authorization", `Bearer ${token}`)
        .send({ token: "ExponentPushToken[real]", platform: "android" })
        .expect(204);

      const stored = await prisma.deviceToken.findFirst({ where: { userId } });
      expect(stored?.token).toBe("ExponentPushToken[real]");
    });

    it("attaches the device to the CALLER, ignoring any userId in the body", async () => {
      // Otherwise anyone could register their own device against a stranger's
      // account and receive that stranger's order notifications.
      await http
        .post("/api/auth/devices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          token: "ExponentPushToken[smuggled]",
          platform: "android",
          userId: "00000000-0000-4000-8000-000000000000",
        })
        // whitelist + forbidNonWhitelisted: an unknown field is rejected
        // outright rather than quietly ignored.
        .expect(400);
    });

    it("rejects a token that is not an Expo push token", async () => {
      await http
        .post("/api/auth/devices")
        .set("Authorization", `Bearer ${token}`)
        .send({ token: "'; DROP TABLE users; --", platform: "android" })
        .expect(400);
    });

    it("rejects an unknown platform", async () => {
      await http
        .post("/api/auth/devices")
        .set("Authorization", `Bearer ${token}`)
        .send({ token: "ExponentPushToken[x]", platform: "blackberry" })
        .expect(400);
    });

    it("refuses an unauthenticated caller", async () => {
      await http
        .post("/api/auth/devices")
        .send({ token: "ExponentPushToken[anon]", platform: "android" })
        .expect(401);
    });
  });

  describe("a push failure must never break the order it reports on", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let notifications: NotificationsService;
    let push: PushService;
    let userId: string;

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      notifications = app.get(NotificationsService);
      push = app.get(PushService);
      userId = (
        await prisma.user.findFirstOrThrow({
          where: { phoneNumber: "+962791111111" },
          select: { id: true },
        })
      ).id;
    });

    afterAll(async () => await app.close());

    it("still records the event when the push service is completely broken", async () => {
      // The order really was cancelled. A phone that could not be reached must
      // not undo that, or fail the merchant's request.
      jest.spyOn(push, "notifyUser").mockRejectedValue(new Error("push is down"));

      expect(() =>
        notifications.orderCancelledByMerchant(userId, "order-xyz", "closing early"),
      ).not.toThrow();

      const events = notifications.eventsFor("order-xyz");
      expect(events[0].type).toBe("order.cancelled_by_merchant");
      expect(events[0].detail).toBe("closing early");

      jest.restoreAllMocks();
    });

    it("sends the shop's cancellation reason to the customer verbatim", async () => {
      // The spec requires the reason reach the customer. Paraphrasing the
      // shop's own words would be worse than useless.
      const sent = jest.spyOn(push, "notifyUser").mockResolvedValue(1);

      notifications.orderCancelledByMerchant(userId, "order-abc", "We are closing early today");

      expect(sent).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          body: expect.stringContaining("We are closing early today"),
        }),
      );
      jest.restoreAllMocks();
    });

    it("does not push internal status changes the customer would not care about", async () => {
      // Pushing every internal transition would train the customer to ignore
      // the notifications that matter.
      const sent = jest.spyOn(push, "notifyUser").mockResolvedValue(1);

      notifications.orderStatusChanged(userId, "order-noise", "SOME_INTERNAL_STATE");

      expect(sent).not.toHaveBeenCalled();
      // The event is still recorded — it is only the phone that stays quiet.
      expect(notifications.eventsFor("order-noise")).toHaveLength(1);
      jest.restoreAllMocks();
    });
  });

  /**
   * Merchant new-order push (the merchant app's B6b).
   *
   * The dashboard's SSE stream only reaches a shopkeeper with the tab open; a
   * merchant carrying a phone needs the new order to arrive on a CLOSED app.
   * This is the one server change the merchant-app work required — the client
   * side (the app) cannot be verified without a device, but the server producing
   * the right push, addressed to the merchant's own devices, is verified here
   * end-to-end: a real customer order lands a real message in the merchant's
   * outbox.
   */
  describe("new order pushes the shopkeeper's phone", () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let notifications: NotificationsService;
    let push: PushService;
    let outbox: ConsolePushSender;
    let http: TestAgent;
    let merchantUserId: string;
    let pilotShopId: string;
    const createdOrderIds: string[] = [];

    beforeAll(async () => {
      ({ app, prisma } = await createTestApp());
      notifications = app.get(NotificationsService);
      push = app.get(PushService);
      outbox = app.get(ConsolePushSender);
      http = request(app.getHttpServer());

      const merchant = await prisma.merchant.findFirstOrThrow({
        where: { user: { phoneNumber: "+962791234567" } },
        select: { id: true, userId: true },
      });
      merchantUserId = merchant.userId;
      pilotShopId = merchant.id;
    });

    afterEach(async () => {
      await prisma.deviceToken.deleteMany({ where: { userId: merchantUserId } });
    });

    afterAll(async () => {
      if (createdOrderIds.length) {
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      await app.close();
    });

    it("addresses the push to the MERCHANT's user, not the customer", () => {
      const sent = jest.spyOn(push, "notifyUser").mockResolvedValue(1);

      notifications.newOrderToMerchant(merchantUserId, "order-m1");

      expect(sent).toHaveBeenCalledWith(
        merchantUserId,
        expect.objectContaining({ title: "New order" }),
      );
      expect(notifications.eventsFor("order-m1")[0].type).toBe("order.new_to_merchant");
      jest.restoreAllMocks();
    });

    it("a broken push must not fail the customer's order", () => {
      jest.spyOn(push, "notifyUser").mockRejectedValue(new Error("push down"));
      expect(() => notifications.newOrderToMerchant(merchantUserId, "order-m2")).not.toThrow();
      jest.restoreAllMocks();
    });

    it("end-to-end: a placed order reaches the merchant's registered device", async () => {
      // The shopkeeper's phone, registered through the same /auth/devices path
      // the customer app uses.
      await push.registerDevice(merchantUserId, "ExponentPushToken[shopkeeper]", "android");

      // A real customer places a real order against the pilot shop.
      const phone = `+962780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
      const otp = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: otp.body.devCode });
      const customerAuth = `Bearer ${verify.body.accessToken}`;

      const product = await prisma.product.findFirstOrThrow({
        where: { merchantId: pilotShopId, isAvailable: true },
        select: { id: true },
      });

      const placed = await http
        .post("/api/orders")
        .set("Authorization", customerAuth)
        .send({ shopId: pilotShopId, items: [{ productId: product.id, quantity: 1 }] })
        .expect(201);
      createdOrderIds.push(placed.body.id);

      // The push is fire-and-forget (not awaited inside the request), so give the
      // microtask a tick to land in the outbox.
      await new Promise((r) => setTimeout(r, 50));

      const message = outbox.lastMessageTo("ExponentPushToken[shopkeeper]");
      expect(message).toBeDefined();
      expect(message?.title).toBe("New order");

      // Remove the order before the customer — the order FK-references the user.
      await prisma.orderItem.deleteMany({ where: { orderId: placed.body.id } });
      await prisma.order.deleteMany({ where: { id: placed.body.id } });
      createdOrderIds.pop();
      await prisma.user.deleteMany({ where: { phoneNumber: phone } });
    });
  });
});
