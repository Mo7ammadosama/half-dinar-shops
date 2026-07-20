/**
 * The customer push seam (launch blocker B6).
 *
 * B6: the customer app must be OPEN to learn anything. A merchant cancels an
 * order and the event fires correctly — but nothing reaches a closed phone, so
 * the customer finds out whenever they next happen to look.
 *
 * Everything that would reach a closed phone goes through this interface, so
 * the delivery mechanism is a configuration choice. Same contract as the SMS
 * and storage seams: pasting credentials switches it live with no code change.
 */

export interface PushMessage {
  /** Expo push token for one device, e.g. "ExponentPushToken[xxx]". */
  to: string;
  title: string;
  body: string;
  /** Small payload the app reads on tap — e.g. which order to open. */
  data?: Record<string, string>;
  /**
   * Android notification-channel id to deliver through.
   *
   * On Android 8+ the SOUND, importance and heads-up behaviour of a notification
   * are properties of the CHANNEL, not the push payload. Without a channelId,
   * Expo delivers through its silent fallback channel and the payload `sound`
   * is effectively ignored — which is exactly why new-order notifications were
   * arriving silently. The app creates a matching high-importance channel with
   * a sound (see each app's src/push.ts). Ignored on iOS.
   */
  channelId?: string;
  /**
   * Sound to play. "default" plays the device's default notification sound.
   * Drives iOS directly, and Android via the matching channel. Defaults to
   * "default" in the sender — a new order must never be silent.
   */
  sound?: string;
}

export interface PushSendResult {
  provider: string;
  /** Provider-assigned id, kept for support. Absent for the dev sender. */
  messageId?: string;
}

/**
 * Thrown when a provider genuinely fails to accept a notification.
 *
 * Callers must NOT let this fail the operation that triggered it: a cancelled
 * order is still cancelled whether or not the phone was told.
 */
export class PushSendError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PushSendError";
  }
}

export interface PushSender {
  readonly name: string;
  /** True when notifications actually reach a closed phone. */
  readonly deliversRealMessages: boolean;
  send(message: PushMessage): Promise<PushSendResult>;
}

/** Injection token — `PushSender` is an interface and erased at runtime. */
export const PUSH_SENDER = Symbol("PUSH_SENDER");
