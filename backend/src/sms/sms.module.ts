import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConsoleSmsSender } from "./console-sms.sender";
import { TwilioSmsSender } from "./twilio-sms.sender";
import { SMS_SENDER, type SmsSender } from "./sms.types";

/**
 * Chooses the SMS implementation from configuration alone.
 *
 * THE DESIGN GOAL: pasting Twilio credentials into .env switches the app to
 * real SMS with **zero code changes**. Provider selection is therefore
 * auto-detecting — if credentials are present, they are used. `SMS_PROVIDER`
 * exists only to force a choice explicitly (e.g. "console" to silence a real
 * provider during a load test without deleting the keys).
 */
export function createSmsSender(
  config: ConfigService,
  /**
   * The DI-managed console sender.
   *
   * Passed in rather than constructed here: `new ConsoleSmsSender()` would
   * create a second, separate instance, so whatever the app actually sent would
   * land in an outbox nobody else holds a reference to. Optional so the factory
   * stays directly unit-testable.
   */
  consoleSender: ConsoleSmsSender = new ConsoleSmsSender(),
): SmsSender {
  const logger = new Logger("SmsModule");

  const explicit = config.get<string>("SMS_PROVIDER")?.trim().toLowerCase();
  const accountSid = config.get<string>("TWILIO_ACCOUNT_SID")?.trim();
  const authToken = config.get<string>("TWILIO_AUTH_TOKEN")?.trim();
  const from = config.get<string>("TWILIO_SMS_FROM")?.trim();
  const messagingServiceSid = config.get<string>("TWILIO_MESSAGING_SERVICE_SID")?.trim();

  const hasTwilioCredentials = Boolean(accountSid && authToken && (from || messagingServiceSid));

  // Explicit wins; otherwise credentials decide.
  const chosen = explicit || (hasTwilioCredentials ? "twilio" : "console");

  if (chosen === "twilio") {
    if (!hasTwilioCredentials) {
      throw new Error(
        "SMS_PROVIDER=twilio, but the Twilio settings are incomplete. Required: " +
          "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either TWILIO_SMS_FROM or " +
          "TWILIO_MESSAGING_SERVICE_SID. See docs/SMS_SETUP.md.",
      );
    }
    logger.log(
      `SMS provider: twilio (sender ${messagingServiceSid ? `service ${messagingServiceSid}` : from})`,
    );
    return new TwilioSmsSender({
      accountSid: accountSid!,
      authToken: authToken!,
      from,
      messagingServiceSid,
      timeoutMs: Number(config.get<string>("SMS_TIMEOUT_MS") ?? 10_000),
    });
  }

  if (chosen !== "console") {
    throw new Error(`Unknown SMS_PROVIDER "${chosen}". Supported: "console", "twilio".`);
  }

  logger.warn(
    "SMS provider: console — login codes are NOT sent by SMS. Development only. " +
      "See docs/SMS_SETUP.md to go live.",
  );
  return consoleSender;
}

@Global()
@Module({
  providers: [
    // Registered concretely as well as behind the token, so tests can reach in
    // and read the dev outbox without knowing which implementation is active.
    ConsoleSmsSender,
    {
      provide: SMS_SENDER,
      inject: [ConfigService, ConsoleSmsSender],
      useFactory: createSmsSender,
    },
  ],
  exports: [SMS_SENDER, ConsoleSmsSender],
})
export class SmsModule {}
