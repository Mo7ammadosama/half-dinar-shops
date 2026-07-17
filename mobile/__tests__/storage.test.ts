import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { clearToken, loadToken, saveToken } from "../src/storage";

/**
 * The encrypted-token rule (launch blocker B4).
 *
 * These run under jest-expo, so Platform.OS is native and expo-secure-store is
 * mocked — the native path is what gets exercised here, which is the path that
 * ships. Real Keychain/Keystore encryption is an OS guarantee and can only be
 * confirmed on hardware; what is testable (and what actually goes wrong) is the
 * routing: does the token go to the keystore, does the plaintext copy get
 * removed, and does a failure ever silently write it in the clear?
 */
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const secure = SecureStore as jest.Mocked<typeof SecureStore>;

const LEGACY_KEY = "halfdinar.customer.token";
const SECURE_KEY = "halfdinar_customer_token";

describe("auth token storage (blocker B4)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    secure.getItemAsync.mockResolvedValue(null);
    secure.setItemAsync.mockResolvedValue(undefined);
    secure.deleteItemAsync.mockResolvedValue(undefined);
  });

  it("writes the token to the encrypted keystore, not to plain storage", async () => {
    await saveToken("jwt-abc");

    expect(secure.setItemAsync).toHaveBeenCalledWith(SECURE_KEY, "jwt-abc");
    // The whole point of B4: nothing lands in the plaintext store.
    expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("reads the token back from the keystore", async () => {
    secure.getItemAsync.mockResolvedValue("jwt-abc");
    expect(await loadToken()).toBe("jwt-abc");
  });

  it("never falls back to plaintext when the keystore write fails", async () => {
    // The dangerous "helpful" fallback. Losing persistence costs one sign-in;
    // writing the token in the clear costs the customer their account.
    secure.setItemAsync.mockRejectedValue(new Error("keystore unavailable"));

    await saveToken("jwt-abc");

    expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("does not crash the app when the keystore cannot be read", async () => {
    // Session restore runs at startup, so a throw here would be a launch crash.
    secure.getItemAsync.mockRejectedValue(new Error("keystore unavailable"));
    await expect(loadToken()).resolves.toBeNull();
  });

  describe("upgrading from a pre-B4 build", () => {
    it("moves an existing plaintext token into the keystore and deletes the original", async () => {
      // A customer who already signed in has a plaintext JWT on disk. Switching
      // to SecureStore without this would leave that token lying there — the app
      // would look fixed while the exact vulnerability B4 describes persisted.
      await AsyncStorage.setItem(LEGACY_KEY, "old-jwt");

      const token = await loadToken();

      expect(token).toBe("old-jwt");
      expect(secure.setItemAsync).toHaveBeenCalledWith(SECURE_KEY, "old-jwt");
      expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it("keeps the customer signed in rather than silently logging them out", async () => {
      await AsyncStorage.setItem(LEGACY_KEY, "old-jwt");
      await expect(loadToken()).resolves.toBe("old-jwt");
    });

    it("removes the plaintext copy even if the keystore write fails", async () => {
      // Failing to encrypt is recoverable (sign in again). Leaving the plaintext
      // token behind is not — it is the vulnerability itself.
      await AsyncStorage.setItem(LEGACY_KEY, "old-jwt");
      secure.setItemAsync.mockRejectedValue(new Error("keystore unavailable"));

      await loadToken();

      expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it("prefers the keystore and does not touch the legacy store once migrated", async () => {
      secure.getItemAsync.mockResolvedValue("new-jwt");
      await AsyncStorage.setItem(LEGACY_KEY, "stale-jwt");

      expect(await loadToken()).toBe("new-jwt");
      // No migration should run — the keystore already answered.
      expect(secure.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe("signing out", () => {
    it("clears the token from BOTH the keystore and any legacy plaintext copy", async () => {
      await AsyncStorage.setItem(LEGACY_KEY, "old-jwt");

      await clearToken();

      expect(secure.deleteItemAsync).toHaveBeenCalledWith(SECURE_KEY);
      expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it("still clears the legacy copy when the keystore delete fails", async () => {
      // Promise.allSettled, not Promise.all: one failure must not abandon the
      // other deletion and leave a usable token on a signed-out device.
      secure.deleteItemAsync.mockRejectedValue(new Error("keystore unavailable"));
      await AsyncStorage.setItem(LEGACY_KEY, "old-jwt");

      await expect(clearToken()).resolves.toBeUndefined();
      expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });
});
