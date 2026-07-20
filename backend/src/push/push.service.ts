import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PUSH_SENDER, PushSendError, type PushMessage, type PushSender } from "./push.types";

/**
 * Sends a notification to every device a customer is signed in on.
 *
 * This sits between NotificationsService (which decides *what* is worth saying)
 * and the sender (which knows *how* to deliver it), so neither has to know
 * about device tokens.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  /** Records a device so its owner can be reached while the app is closed. */
  async registerDevice(userId: string, token: string, platform?: string) {
    // Upsert on the token, not the user: the same device can be handed to a
    // different account (a shared family phone), and the token must then follow
    // the new owner rather than notify the old one.
    await this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform, lastSeenAt: new Date() },
      create: { userId, token, platform },
    });
  }

  /**
   * Forgets one of the caller's own devices — called on sign-out.
   *
   * Scoped by userId as well as token: a push token is not a secret (it is
   * handed to Expo, and could leak), so knowing one must not be enough to
   * silence a stranger's phone and make them miss their order updates.
   */
  async unregisterOwnDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  /**
   * Notifies one customer on all their devices.
   *
   * NEVER throws. Every caller is reporting something that has already happened
   * — an order really was cancelled — and a push failure must not roll that
   * back or fail the request. Delivery is best-effort by nature: the phone may
   * be off, reinstalled, or out of coverage.
   */
  async notifyUser(
    userId: string,
    // Everything about a message except its destination token — includes the
    // Android channelId + sound, so callers can route order pushes to the
    // sound-enabled channel (see NotificationsService.ORDER_PUSH_CHANNEL_ID).
    message: Omit<PushMessage, "to">,
  ): Promise<number> {
    let devices: Array<{ token: string }>;
    try {
      devices = await this.prisma.deviceToken.findMany({
        where: { userId },
        select: { token: true },
      });
    } catch (error) {
      this.logger.error(`Could not read device tokens for ${userId}: ${String(error)}`);
      return 0;
    }

    if (devices.length === 0) return 0;

    let delivered = 0;
    for (const device of devices) {
      try {
        await this.sender.send({ to: device.token, ...message });
        delivered++;
      } catch (error) {
        if (error instanceof PushSendError && /DeviceNotRegistered/i.test(error.message)) {
          // The app was uninstalled or the token rotated. Drop it rather than
          // retrying a dead token on every future order for the rest of time.
          this.logger.log(`Dropping dead push token for user ${userId}`);
          await this.prisma.deviceToken
            .deleteMany({ where: { token: device.token } })
            .catch(() => undefined);
          continue;
        }
        this.logger.warn(
          `Push to one device failed for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return delivered;
  }

  /** Whether notifications actually reach a closed phone. Drives the B6 log. */
  get deliversRealMessages(): boolean {
    return this.sender.deliversRealMessages;
  }
}
