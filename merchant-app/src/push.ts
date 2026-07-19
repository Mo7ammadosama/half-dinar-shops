/**
 * Push notification registration — MERCHANT side (launch blocker B6b).
 *
 * Gets a push token for this device and registers it with the API, so a new
 * order wakes the shopkeeper's phone while the app is CLOSED. The server sends
 * that push from orders.service.ts on every new order (see
 * NotificationsService.newOrderToMerchant) — this is the client half.
 *
 * Identical discipline to the customer app's src/push.ts:
 *
 *  1. **expo-notifications is required LAZILY.** Its native binding runs at
 *     import time; an eager import of an optional native module crashed this
 *     project on a real phone before.
 *  2. **Nothing here can fail the app.** A merchant who refuses notifications
 *     still gets orders via the in-app poll — push makes them immediate on a
 *     closed phone, it is not the only channel.
 *  3. **Web is a no-op.** The Playwright suite runs on the web target, which has
 *     no push token to fetch.
 */
import { Platform } from "react-native";
import type * as NotificationsTypes from "expo-notifications";
import { api } from "./api";

export type PushRegistration =
  | { status: "registered"; token: string }
  | { status: "denied" }
  | { status: "unsupported"; reason: string };

function notifications(): typeof NotificationsTypes | null {
  if (Platform.OS === "web") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications") as typeof NotificationsTypes;
  } catch {
    return null;
  }
}

/** Asks for permission, gets a token, registers it. Never throws. */
export async function registerForPush(): Promise<PushRegistration> {
  const Notifications = notifications();
  if (!Notifications) {
    return { status: "unsupported", reason: "Push is not available on this platform." };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Device = require("expo-device") as typeof import("expo-device");
    if (!Device.isDevice) {
      return { status: "unsupported", reason: "Push needs a physical device." };
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return { status: "denied" };

    if (Platform.OS === "android") {
      // A new order is the most time-critical thing this app does — HIGH so it
      // is not delivered silently.
      await Notifications.setNotificationChannelAsync("orders", {
        name: "New orders",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    await api.registerDevice(token, Platform.OS === "ios" ? "ios" : "android");
    return { status: "registered", token };
  } catch (error) {
    return {
      status: "unsupported",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Stops this device receiving notifications. Best-effort, called on sign-out. */
export async function unregisterFromPush(): Promise<void> {
  const Notifications = notifications();
  if (!Notifications) return;
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync();
    await api.unregisterDevice(token);
  } catch {
    // Nothing to do — the token is gone or was never issued.
  }
}
