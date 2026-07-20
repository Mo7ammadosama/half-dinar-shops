import { Logger } from "@nestjs/common";
import type { PushMessage, PushSender, PushSendResult } from "./push.types";
import { PushSendError } from "./push.types";

export interface ExpoPushConfig {
  /**
   * Optional Expo access token.
   *
   * Expo's push service accepts unauthenticated sends, but enabling "enhanced
   * security" in the Expo dashboard requires this. Supported so turning that on
   * later is a config change, not a code change.
   */
  accessToken?: string;
  timeoutMs: number;
}

/**
 * Expo's push service — the production implementation for B6.
 *
 * Expo is the right choice here because the app is already an Expo app: it
 * hands the same API to both FCM (Android) and APNs (iOS), so there is no
 * per-platform code, and no Apple/Google server credentials to manage in this
 * backend.
 *
 * Implemented with `fetch` rather than `expo-server-sdk` for the same reason
 * the SMS sender avoids the Twilio SDK: it is one JSON POST, and the SDK is a
 * dependency and audit surface for that.
 */
export class ExpoPushSender implements PushSender {
  readonly name = "expo";
  readonly deliversRealMessages = true;

  private readonly logger = new Logger(ExpoPushSender.name);

  constructor(private readonly config: ExpoPushConfig) {}

  async send(message: PushMessage): Promise<PushSendResult> {
    let response: Response;
    try {
      response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.config.accessToken
            ? { Authorization: `Bearer ${this.config.accessToken}` }
            : {}),
        },
        body: JSON.stringify({
          to: message.to,
          title: message.title,
          body: message.body,
          data: message.data,
          // An order update is worth waking the screen for; it is time-critical
          // and the customer is actively waiting on it.
          priority: "high",
          // "default" plays the device's default sound. A new order must never
          // be silent — the shopkeeper is not staring at the phone.
          sound: message.sound ?? "default",
          // CRITICAL for Android sound: without a channelId Expo delivers through
          // its silent fallback channel and the sound above is ignored. Routed to
          // the high-importance, sound-enabled channel the app creates. Harmless
          // on iOS (which has no channels — the payload `sound` drives it there).
          ...(message.channelId ? { channelId: message.channelId } : {}),
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      throw new PushSendError(
        `Could not reach the push service: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.name,
        cause,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { id?: string; status?: string; message?: string; details?: { error?: string } };
      errors?: Array<{ message?: string }>;
    };

    if (!response.ok || payload.errors?.length) {
      throw new PushSendError(
        `Push service rejected the notification (HTTP ${response.status}): ${
          payload.errors?.[0]?.message ?? "no detail"
        }`,
        this.name,
      );
    }

    // Expo answers 200 with a per-message status; "error" here still means it
    // was not delivered, so it must not be mistaken for success.
    if (payload.data?.status === "error") {
      // DeviceNotRegistered means the app was uninstalled or the token rotated.
      // Surfaced distinctly so the caller can drop a dead token rather than
      // retrying it forever.
      const detail = payload.data.details?.error ?? payload.data.message ?? "unknown error";
      throw new PushSendError(`Push not delivered: ${detail}`, this.name);
    }

    return { provider: this.name, messageId: payload.data?.id };
  }
}
