import { Injectable, Logger } from "@nestjs/common";
import type { PushMessage, PushSender, PushSendResult } from "./push.types";

/**
 * Development sender: logs the notification instead of delivering it.
 *
 * Keeps local development and the automated tests working with no Expo project
 * or physical device. Reports `deliversRealMessages = false`, which is what
 * lets the app tell the truth about B6 at startup rather than appearing to have
 * push when it does not.
 */
@Injectable()
export class ConsolePushSender implements PushSender {
  readonly name = "console";
  readonly deliversRealMessages = false;

  private readonly logger = new Logger(ConsolePushSender.name);

  private readonly sent: PushMessage[] = [];

  async send(message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    this.logger.log(
      `PUSH (not delivered — dev sender) to ${message.to}: ${message.title} — ${message.body}`,
    );
    return { provider: this.name };
  }

  /** Test helper: everything this sender was asked to deliver. */
  outbox(): readonly PushMessage[] {
    return this.sent;
  }

  /** Test helper: the most recent notification for a device token. */
  lastMessageTo(to: string): PushMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
