/**
 * Persisted session + delivery-area state.
 *
 * The auth token (a JWT valid for 7 days) is held in the device's **encrypted**
 * keystore — Keychain on iOS, Keystore on Android — via expo-secure-store. This
 * closes launch blocker B4: AsyncStorage is plain text on disk, so on a rooted,
 * jailbroken or backed-up device the token could be lifted and replayed.
 *
 * Two things about this file are deliberate and worth not "simplifying":
 *
 * 1. **expo-secure-store is required lazily, never imported at module scope.**
 *    Its native binding runs `requireNativeModule()` at import time, and this
 *    module IS on the eager App→startup path. An eager import is exactly what
 *    crashed the app on a real phone before (see "Native startup crash" in the
 *    root CLAUDE.md — expo-location, same failure shape). A lazy require means a
 *    problem loading the module degrades to "please sign in again" rather than a
 *    fatal launch crash.
 *
 * 2. **SecureStore does not exist on web.** The automated browser suite runs on
 *    Expo's web target, so the web path falls back to AsyncStorage. That is not
 *    a security regression: the web target is a test harness, not a shipped
 *    product. Customers get the native app, which uses the keystore.
 *
 * The delivery area is not a secret and stays in AsyncStorage.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type * as SecureStoreTypes from "expo-secure-store";

const TOKEN_KEY = "halfdinar.customer.token";
const AREA_KEY = "halfdinar.customer.area";

/** SecureStore keys may only contain alphanumerics, ".", "-" and "_". */
const SECURE_TOKEN_KEY = "halfdinar_customer_token";

/** SecureStore is native-only; the web target has no keystore to talk to. */
const canUseSecureStore = Platform.OS !== "web";

/**
 * Loads expo-secure-store on demand.
 *
 * Returns null instead of throwing, so a missing or broken native module can
 * never take down the app at startup.
 */
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
    // Web target only — see the note at the top of this file.
    try {
      return await AsyncStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  try {
    const token = await store.getItemAsync(SECURE_TOKEN_KEY);
    if (token) return token;

    // Nothing in the keystore. A customer who used an older build still has a
    // plaintext token sitting in AsyncStorage, so move it across and delete the
    // original. Without this the app would look upgraded while the very token
    // B4 is about still lay unencrypted on disk — and the customer would be
    // silently signed out for no reason.
    return await migrateLegacyToken(store);
  } catch (error) {
    // A read failure must not block the app; the customer just signs in again.
    console.warn("Could not read the saved session.", error);
    return null;
  }
}

/**
 * Moves a token written by a pre-B4 build into the keystore.
 *
 * The old plaintext copy is removed whether or not the migration succeeds —
 * leaving it behind is the exact vulnerability being closed.
 */
async function migrateLegacyToken(store: typeof SecureStoreTypes): Promise<string | null> {
  let legacy: string | null = null;
  try {
    legacy = await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
  if (!legacy) return null;

  try {
    await store.setItemAsync(SECURE_TOKEN_KEY, legacy);
  } catch (error) {
    console.warn("Could not move the saved session into secure storage.", error);
  }

  try {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Best effort — the keystore copy is authoritative from here on.
  }

  return legacy;
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
    // Deliberately NOT falling back to AsyncStorage on a native device: writing
    // the token in plain text is the thing B4 exists to prevent. Losing session
    // persistence costs the customer one extra sign-in; storing it unencrypted
    // costs them their account.
    console.warn("Could not save the session securely; it will not persist.", error);
  }
}

export async function clearToken(): Promise<void> {
  const store = secureStore();

  // Clear both locations regardless of platform. Signing out must remove every
  // copy, including a legacy plaintext one an upgrade may not have reached yet.
  await Promise.allSettled([
    store ? store.deleteItemAsync(SECURE_TOKEN_KEY) : Promise.resolve(),
    AsyncStorage.removeItem(TOKEN_KEY),
  ]);
}

export async function loadArea(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(AREA_KEY);
  } catch {
    return null;
  }
}

export async function saveArea(area: string): Promise<void> {
  await AsyncStorage.setItem(AREA_KEY, area);
}
