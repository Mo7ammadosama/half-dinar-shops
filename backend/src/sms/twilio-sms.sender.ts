import { Logger } from "@nestjs/common";
import type { SmsMessage, SmsSender, SmsSendResult } from "./sms.types";
import { SmsSendError } from "./sms.types";

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  /**
   * The registered Alphanumeric Sender ID (e.g. "HalfDinar").
   *
   * Jordan does NOT support numeric long codes — operators overwrite a numeric
   * sender with a generic alphanumeric one, and Zain/Orange block generic
   * senders outright. So for Jordan this must be a *pre-registered*
   * alphanumeric ID. See docs/SMS_SETUP.md.
   */
  from?: string;
  /** Alternative to `from`: a Messaging Service that owns the sender pool. */
  messagingServiceSid?: string;
  /** Milliseconds before a send is abandoned. */
  timeoutMs: number;
}

/**
 * Twilio Programmable SMS over the REST API.
 *
 * Implemented with `fetch` rather than the `twilio` SDK deliberately: the call
 * is a single form-encoded POST, and the SDK is a large dependency (and audit
 * surface) for one request. If Twilio's API shape ever changes this is the only
 * file that needs to know.
 */
export class TwilioSmsSender implements SmsSender {
  readonly name = "twilio";
  readonly deliversRealMessages = true;

  private readonly logger = new Logger(TwilioSmsSender.name);

  constructor(private readonly config: TwilioSmsConfig) {
    if (!config.from && !config.messagingServiceSid) {
      throw new Error(
        "Twilio SMS needs either TWILIO_SMS_FROM (a registered Alphanumeric Sender ID) " +
          "or TWILIO_MESSAGING_SERVICE_SID.",
      );
    }
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      this.config.accountSid,
    )}/Messages.json`;

    const form = new URLSearchParams({ To: message.to, Body: message.body });
    if (this.config.messagingServiceSid) {
      form.set("MessagingServiceSid", this.config.messagingServiceSid);
    } else if (this.config.from) {
      form.set("From", this.config.from);
    }

    // Basic auth, per Twilio's REST API.
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString(
      "base64",
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      // Network failure or timeout — the gateway never answered.
      throw new SmsSendError(
        `Could not reach the SMS gateway: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.name,
        cause,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
      code?: number;
    };

    if (!response.ok) {
      // Twilio returns a numeric `code` that is far more useful than the HTTP
      // status when diagnosing (e.g. 21612 = unreachable carrier/sender combo).
      throw new SmsSendError(
        `SMS gateway rejected the message (HTTP ${response.status}` +
          `${payload.code ? `, Twilio code ${payload.code}` : ""}): ${payload.message ?? "no detail"}`,
        this.name,
      );
    }

    this.logger.log(`SMS accepted by Twilio for ${message.to} (sid ${payload.sid ?? "unknown"})`);
    return { provider: this.name, messageId: payload.sid };
  }
}
