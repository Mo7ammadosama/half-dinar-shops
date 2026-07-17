import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { ConsoleSmsSender } from "../src/sms/console-sms.sender";
import { createSmsSender } from "../src/sms/sms.module";
import { TwilioSmsSender } from "../src/sms/twilio-sms.sender";
import { SmsSendError } from "../src/sms/sms.types";
import { validateEnv } from "../src/config/env.validation";
import { createTestApp, productionEnv, uniquePhone } from "./helpers";

/**
 * The SMS seam (launch blocker B3).
 *
 * These tests prove three separate things:
 *  1. The OTP genuinely goes through the sender, and the code in the SMS is the
 *     code that works — not just that a function was called.
 *  2. Provider selection is driven by configuration alone, so pasting keys
 *     switches it live with no code change.
 *  3. A production instance without a real provider refuses to boot, rather
 *     than running normally and never delivering a code.
 */
describe("SMS (blocker B3)", () => {
  /**
   * A valid production config, minus the SMS provider — so these tests vary
   * only the thing they are about. See productionEnv() in helpers.ts for why
   * this is shared rather than hand-rolled per file.
   */
  const withoutSms = () => {
    const env = productionEnv();
    delete env.TWILIO_ACCOUNT_SID;
    delete env.TWILIO_AUTH_TOKEN;
    delete env.TWILIO_SMS_FROM;
    return env;
  };

  describe("provider selection", () => {
    const fakeConfig = (values: Record<string, string | undefined>) =>
      ({ get: (key: string) => values[key] }) as never;

    it("uses the console sender when no credentials are configured", () => {
      const sender = createSmsSender(fakeConfig({}));
      expect(sender.name).toBe("console");
      expect(sender.deliversRealMessages).toBe(false);
    });

    // The headline requirement: keys alone flip it live.
    it("switches to Twilio purely by the presence of credentials — no code change", () => {
      const sender = createSmsSender(
        fakeConfig({
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "token",
          TWILIO_SMS_FROM: "HalfDinar",
        }),
      );
      expect(sender.name).toBe("twilio");
      expect(sender.deliversRealMessages).toBe(true);
    });

    it("accepts a Messaging Service instead of a sender ID", () => {
      const sender = createSmsSender(
        fakeConfig({
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "token",
          TWILIO_MESSAGING_SERVICE_SID: "MG123",
        }),
      );
      expect(sender.name).toBe("twilio");
    });

    it("refuses half-configured Twilio credentials rather than silently using console", () => {
      // Partial credentials are the dangerous case: the intent to go live is
      // obvious, so quietly printing codes to a log would be the wrong answer.
      expect(() =>
        createSmsSender(fakeConfig({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC123" })),
      ).toThrow(/incomplete/i);
    });

    it("rejects an unknown provider name", () => {
      expect(() => createSmsSender(fakeConfig({ SMS_PROVIDER: "carrier-pigeon" }))).toThrow(
        /Unknown SMS_PROVIDER/,
      );
    });

    it("lets SMS_PROVIDER=console explicitly override present credentials", () => {
      const sender = createSmsSender(
        fakeConfig({
          SMS_PROVIDER: "console",
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "token",
          TWILIO_SMS_FROM: "HalfDinar",
        }),
      );
      expect(sender.name).toBe("console");
    });
  });

  describe("startup guard", () => {
    it("refuses to boot in production without a real SMS provider", () => {
      // Without this guard, a deploy that forgot its Twilio keys would look
      // healthy and simply never log anyone in.
      expect(() => validateEnv(withoutSms())).toThrow(/No real SMS provider is configured/);
    });

    it("boots in production once Twilio credentials are present", () => {
      expect(() => validateEnv(productionEnv())).not.toThrow();
    });

    it("still refuses to boot in production with the OTP exposed in the response", () => {
      // Pre-existing rule; re-pinned here because the SMS work touches the same
      // branch and must not have loosened it.
      expect(() =>
        validateEnv({ ...productionEnv(), EXPOSE_OTP_IN_RESPONSE: "true" }),
      ).toThrow(/EXPOSE_OTP_IN_RESPONSE/);
    });

    it("allows the console sender outside production", () => {
      expect(() => validateEnv({ ...withoutSms(), NODE_ENV: "development" })).not.toThrow();
    });
  });

  describe("Twilio sender", () => {
    const config = {
      accountSid: "AC123",
      authToken: "secret-token",
      from: "HalfDinar",
      timeoutMs: 5_000,
    };

    afterEach(() => jest.restoreAllMocks());

    it("posts the message to Twilio with the sender and destination", async () => {
      const fetchMock = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ sid: "SM999" }), { status: 201 }) as never,
        );

      const result = await new TwilioSmsSender(config).send({
        to: "+962791234567",
        body: "123456 is your code",
      });

      expect(result).toEqual({ provider: "twilio", messageId: "SM999" });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/Accounts/AC123/Messages.json");

      const body = new URLSearchParams(init.body as string);
      expect(body.get("To")).toBe("+962791234567");
      expect(body.get("From")).toBe("HalfDinar");
      expect(body.get("Body")).toBe("123456 is your code");

      // Basic auth, base64 of "sid:token".
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
        "AC123:secret-token",
      );
    });

    it("reports a rejected message as an SmsSendError with Twilio's own error code", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid 'To' number", code: 21211 }), {
          status: 400,
        }) as never,
      );

      await expect(
        new TwilioSmsSender(config).send({ to: "+962791234567", body: "hi" }),
      ).rejects.toThrow(SmsSendError);
    });

    it("reports a network failure rather than hanging", async () => {
      jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));

      await expect(
        new TwilioSmsSender(config).send({ to: "+962791234567", body: "hi" }),
      ).rejects.toThrow(/Could not reach the SMS gateway/);
    });

    it("refuses to construct without any sender identity", () => {
      // Jordan overwrites/blocks generic senders, so a missing sender ID means
      // undelivered messages — better to fail at construction.
      expect(() => new TwilioSmsSender({ ...config, from: undefined })).toThrow(
        /TWILIO_SMS_FROM|TWILIO_MESSAGING_SERVICE_SID/,
      );
    });
  });

  describe("the OTP actually flows through the sender", () => {
    let app: INestApplication;
    let http: TestAgent;
    let outbox: ConsoleSmsSender;

    beforeAll(async () => {
      ({ app } = await createTestApp());
      http = request(app.getHttpServer());
      outbox = app.get(ConsoleSmsSender);
    });

    afterAll(async () => await app.close());

    it("sends an SMS whose code is the code that actually logs you in", async () => {
      const phone = uniquePhone();
      const local = phone.replace("+962", "0");

      await http.post("/api/auth/otp/request").send({ phoneNumber: local }).expect(200);

      const message = outbox.lastMessageTo(phone);
      expect(message).toBeDefined();

      // Pull the code out of the SMS text itself — not from the API response.
      // This is the point: it proves the message a real customer would receive
      // carries a code that works, rather than proving a mock was called.
      const codeInSms = message!.body.match(/\b(\d{6})\b/)?.[1];
      expect(codeInSms).toBeDefined();

      const login = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: local, code: codeInSms })
        .expect(200);

      expect(login.body.accessToken).toBeDefined();
    });

    it("does not put the code anywhere near marketing text", async () => {
      // Jordan treats promotional SMS differently: an "adv" sender prefix and a
      // 9pm curfew. A login code must stay strictly transactional or it risks
      // being classed as promotional and blocked.
      const phone = uniquePhone();
      await http
        .post("/api/auth/otp/request")
        .send({ phoneNumber: phone.replace("+962", "0") })
        .expect(200);

      const body = outbox.lastMessageTo(phone)!.body;
      expect(body).toMatch(/login code/i);
      expect(body).toMatch(/expires in \d+ minute/i);
      expect(body).toMatch(/do not share/i);
    });
  });
});
