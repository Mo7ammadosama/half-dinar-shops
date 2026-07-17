import { Injectable, Logger } from "@nestjs/common";
import type { SmsMessage, SmsSender, SmsSendResult } from "./sms.types";

/**
 * Development sender: prints the message instead of sending it.
 *
 * This is the implementation that keeps local development working with no
 * provider account. It pairs with EXPOSE_OTP_IN_RESPONSE, which returns the
 * code to the caller so the dashboard and app can prefill it.
 *
 * It reports `deliversRealMessages = false`, and env.validation.ts refuses to
 * boot a production instance that would rely on it — so this cannot quietly
 * become the production path.
 */
@Injectable()
export class ConsoleSmsSender implements SmsSender {
  readonly name = "console";
  readonly deliversRealMessages = false;

  private readonly logger = new Logger(ConsoleSmsSender.name);

  /** Sent messages, retained so tests can assert what would have gone out. */
  private readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push(message);
    this.logger.log(`SMS (not sent — dev sender) to ${message.to}: ${message.body}`);
    return { provider: this.name };
  }

  /** Test helper: everything this sender was asked to send. */
  outbox(): readonly SmsMessage[] {
    return this.sent;
  }

  /** Test helper: the most recent message for a number, if any. */
  lastMessageTo(to: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
