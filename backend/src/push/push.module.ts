import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConsolePushSender } from "./console-push.sender";
import { ExpoPushSender } from "./expo-push.sender";
import { PushService } from "./push.service";
import { PUSH_SENDER, type PushSender } from "./push.types";

/**
 * Chooses the push implementation from configuration alone.
 *
 * Same contract as the SMS and storage seams: setting the env var switches it
 * live with zero code changes.
 *
 * Note the asymmetry with those two: push has NO production startup guard. That
 * is deliberate — an SMS provider is required for anyone to log in at all, and
 * durable storage is required for photos not to be destroyed, but a pilot can
 * genuinely run without push while the founder gets an Expo project set up. The
 * cost is that the customer must open the app to see an update (which is
 * exactly blocker B6), not that the product breaks. Refusing to boot over it
 * would be a worse trade. It is logged loudly at startup instead.
 */
export function createPushSender(
  config: ConfigService,
  consoleSender: ConsolePushSender = new ConsolePushSender(),
): PushSender {
  const logger = new Logger("PushModule");

  const explicit = config.get<string>("PUSH_PROVIDER")?.trim().toLowerCase();
  // Expo's push API accepts unauthenticated sends, so there is no credential to
  // auto-detect. Enabling it is therefore an explicit opt-in.
  const chosen = explicit || "console";

  if (chosen === "expo") {
    logger.log("Push notifications: expo");
    return new ExpoPushSender({
      accessToken: config.get<string>("EXPO_ACCESS_TOKEN")?.trim(),
      timeoutMs: Number(config.get<string>("PUSH_TIMEOUT_MS") ?? 10_000),
    });
  }

  if (chosen !== "console") {
    throw new Error(`Unknown PUSH_PROVIDER "${chosen}". Supported: "console", "expo".`);
  }

  logger.warn(
    "Push notifications: console — customers will NOT be notified on a closed phone " +
      "(launch blocker B6). See docs/PUSH_SETUP.md to go live.",
  );
  return consoleSender;
}

@Global()
@Module({
  providers: [
    ConsolePushSender,
    {
      provide: PUSH_SENDER,
      inject: [ConfigService, ConsolePushSender],
      useFactory: createPushSender,
    },
    PushService,
  ],
  exports: [PUSH_SENDER, ConsolePushSender, PushService],
})
export class PushModule {}
