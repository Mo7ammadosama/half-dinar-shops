/**
 * Push notification registration (launch blocker B6).
 *
 * Gets a push token for this device and hands it to the API, so the customer
 * can be told their order was cancelled, or that an item is out of stock, while
 * the app is CLOSED. Today they only find out when they next happen to look.
 *
 * THREE RULES THIS FILE FOLLOWS, all learned the hard way in this project:
 *
 * 1. **expo-notifications is required LAZILY, never imported at module scope.**
 *    Its native binding runs at import time. An eager import of an optional
 *    native module is exactly what crashed this app on the founder's phone
 *    before (expo-location — see "Native startup crash" in the root CLAUDE.md).
 *
 * 2. **Nothing here can fail the app.** Every function swallows its errors and
 *    returns a result. Push is a nice-to-have: a customer who refuses
 *    notifications, or whose device cannot get a token, must still be able to
 *    shop. Notifications are how we reach them, not how they use the app.
 *
 * 3. **Web is a no-op.** The automated browser suite runs on Expo's web target,
 *    which has no push token to fetch. Returning early keeps the tests honest
 *    rather than making them fail for an irrelevant reason.
 */
import { Platform } from "react-native";
import type * as NotificationsTypes from "expo-notifications";
import { api } from "./api";

export type PushRegistration =
  | { status: "registered"; token: string }
  | { status: "denied" }
  | { status: "unsupported"; reason: string };

/** Loads expo-notifications on demand. Null rather than throwing. */
function notifications(): typeof NotificationsTypes | null {
  if (Platform.OS === "web") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications") as typeof NotificationsTypes;
  } catch {
    return null;
  }
}

/**
 * Asks for permission, gets a token, and registers it with the API.
 *
 * Never throws. Call it after sign-in — asking a stranger for notification
 * permission before they have an order to be notified about gets refused on
 * reflex, and on iOS that refusal is permanent.
 */
export async function registerForPush(): Promise<PushRegistration> {
  const Notifications = notifications();
  if (!Notifications) {
    return { status: "unsupported", reason: "Push is not available on this platform." };
  }

  try {
    // A simulator cannot receive push, and asking would only produce a
    // confusing error during development.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Device = require("expo-device") as typeof import("expo-device");
    if (!Device.isDevice) {
      return { status: "unsupported", reason: "Push needs a physical device." };
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;

    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted) return { status: "denied" };

    // Android needs a channel or notifications arrive silently — which for an
    // order update is the same as not arriving at all. On Android 8+ the SOUND
    // is a property of the CHANNEL, not the push payload, so the channel must
    // explicitly enable it. HIGH makes a sound and a heads-up notification.
    //
    // The channel id is "orders-v2", NOT "orders": Android channels are
    // immutable once created, so reusing the old soundless "orders" id would
    // leave already-installed phones silent forever. A fresh id is created with
    // sound on. Must stay in step with ORDER_PUSH_CHANNEL_ID on the server.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("orders-v2", {
        name: "Order updates",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250],
        enableVibrate: true,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync();

    await api.registerDevice(token, Platform.OS === "ios" ? "ios" : "android");

    return { status: "registered", token };
  } catch (error) {
    // Includes the common case of a missing EAS projectId in the manifest,
    // which cannot be fixed at runtime and must not break sign-in.
    return {
      status: "unsupported",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stops this device receiving notifications. Call on sign-out.
 *
 * Best-effort: a failure here is not worth blocking sign-out over. The worst
 * case is a signed-out phone showing one more order update.
 */
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
