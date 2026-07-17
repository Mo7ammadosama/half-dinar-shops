/**
 * The SMS seam.
 *
 * Everything that sends a text message goes through this interface, so the
 * provider is a configuration choice rather than a code change. Swapping
 * Twilio for Unifonic (or any aggregator) means adding one class that
 * implements `SmsSender` and one branch in the factory — no caller changes.
 */

export interface SmsMessage {
  /** E.164 destination, e.g. +962791234567. */
  to: string;
  /** Plain text body. */
  body: string;
}

export interface SmsSendResult {
  /** Provider-assigned id, kept for support/debugging. Absent for the dev sender. */
  messageId?: string;
  /** Which implementation actually handled it — surfaced in logs and health output. */
  provider: string;
}

/**
 * Thrown when a provider genuinely fails to accept a message.
 *
 * This is deliberately distinct from a validation error: it means "the gateway
 * did not take it", which the caller must surface rather than swallow — a
 * customer waiting for a code that was never sent has no way to self-diagnose.
 */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}

export interface SmsSender {
  /** Short name of the implementation, e.g. "console" or "twilio". */
  readonly name: string;

  /**
   * True when messages actually leave the building.
   *
   * The dev sender returns false, which is what lets the app decide whether the
   * on-screen code path is still needed. It is NOT a substitute for the
   * production guard in env.validation.ts.
   */
  readonly deliversRealMessages: boolean;

  send(message: SmsMessage): Promise<SmsSendResult>;
}

/** Injection token — `SmsSender` is an interface and erased at runtime. */
export const SMS_SENDER = Symbol("SMS_SENDER");
