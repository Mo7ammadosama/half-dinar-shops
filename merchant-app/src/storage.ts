/**
 * Persisted merchant session.
 *
 * The auth token (a JWT) is held in the device's **encrypted** keystore —
 * Keychain on iOS, Keystore on Android — via expo-secure-store, exactly as the
 * customer app does (launch blocker B4). A merchant token is arguably more
 * sensitive than a customer's: it can accept and cancel real orders.
 *
 * Two deliberate choices, mirrored from mobile/src/storage.ts — do not
 * "simplify" either:
 *
 * 1. **expo-secure-store is required lazily, never at module scope.** Its native
 *    binding runs requireNativeModule() at import time, and this module IS on the
 *    eager startup path. An eager import of an optional native module is what
 *    crashed the customer app on a real phone before (see the root CLAUDE.md
 *    "Native startup crash"). A lazy require degrades a load failure to "please
 *    sign in again" rather than a fatal launch crash.
 *
 * 2. **SecureStore does not exist on web.** The Playwright suite runs on Expo's
 *    web target, which falls back to AsyncStorage. That is a test harness, not a
 *    shipped product; the merchant gets the native app and the keystore.
 *
 * The token key is DISTINCT from the customer app's, so the two apps installed
 * side by side never read each other's session.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type * as SecureStoreTypes from "expo-secure-store";

const TOKEN_KEY = "halfdinar.merchant.token";
/** SecureStore keys may only contain alphanumerics, ".", "-" and "_". */
const SECURE_TOKEN_KEY = "halfdinar_merchant_token";

const canUseSecureStore = Platform.OS !== "web";

function secureStore(): typeof SecureStoreTypes | null {
  if (!canUseSecureStore) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-secure-store") as typeof SecureStoreTypes;
  } catch (error) {
    console.warn("expo-secure-store unavailable; the session will not persist.", error);
    return null;
  }
}

export async function loadToken(): Promise<string | null> {
  const store = secureStore();
  if (!store) {
    try {
      return await AsyncStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }
  try {
    return await store.getItemAsync(SECURE_TOKEN_KEY);
  } catch (error) {
    console.warn("Could not read the saved session.", error);
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  const store = secureStore();
  if (!store) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  try {
    await store.setItemAsync(SECURE_TOKEN_KEY, token);
  } catch (error) {
    // Deliberately NOT falling back to plaintext AsyncStorage on a device: an
    // unencrypted merchant token is the very thing B4 exists to prevent. Losing
    // persistence costs one extra sign-in; storing it in plaintext costs the shop.
    console.warn("Could not save the session securely; it will not persist.", error);
  }
}

export async function clearToken(): Promise<void> {
  const store = secureStore();
  // Clear both locations regardless of platform, so sign-out removes every copy.
  await Promise.allSettled([
    store ? store.deleteItemAsync(SECURE_TOKEN_KEY) : Promise.resolve(),
    AsyncStorage.removeItem(TOKEN_KEY),
  ]);
}
