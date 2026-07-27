import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  api,
  setAuthToken,
  setUnauthorizedHandler,
  type SessionInvalidReason,
  type Shop,
} from "./src/api";
import { BrowseScreen } from "./src/BrowseScreen";
import { ErrorBoundary } from "./src/ErrorBoundary";
import { LoginScreen } from "./src/LoginScreen";
import type { Place } from "./src/location";
// Safe on the startup path: push.ts require()s expo-notifications lazily inside
// its functions and only imports Platform + api at module scope. An eager
// native import here is what crashed the app on a real phone before.
import { registerForPush, unregisterFromPush } from "./src/push";
import { ShopsScreen } from "./src/ShopsScreen";
import { clearToken, loadArea, loadToken, saveArea, saveToken } from "./src/storage";
// Initialises i18next as a side effect, and exposes the startup restore.
import { restoreLanguage } from "./src/i18n";
import { colors } from "./src/theme";

export default function App() {
  // null = not signed in; undefined = still restoring the saved session.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [area, setArea] = useState<string | null>(null);
  // Set when we returned to sign-in because the saved session was rejected — the
  // login screen shows why ("expired" vs a shop/admin token in "wrongRole")
  // rather than silently showing a fresh form.
  const [loginNotice, setLoginNotice] = useState<SessionInvalidReason | null>(null);

  // Delivery location, lifted here so it survives navigating in and out of a
  // shop. The shop list uses it to sort shops by distance.
  const [place, setPlace] = useState<Place>({ kind: "unset" });
  // Which shop the customer has opened; null = still on the shop list.
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);

  /**
   * Ends a session the SERVER rejected — a 401 (expired/revoked) or a role 403
   * (a valid but non-customer token). Deliberately makes NO API calls — that
   * rejection is exactly what brought us here, so re-calling the API (e.g. to
   * unregister push) would only fail again. Clears the token and drops the
   * customer on sign-in with a reason.
   */
  const endSession = useCallback((reason: SessionInvalidReason) => {
    setAuthToken(null);
    void clearToken();
    setSelectedShop(null);
    setLoginNotice(reason);
    setToken(null);
  }, []);

  // A request made WITH a token that comes back 401 (dead session) or a role 403
  // (a shop/admin token in the customer app) returns the customer to a clean
  // sign-in — never a trapped shell, and never a raw "requires the CUSTOMER role"
  // string. (The api layer gates this to responses that actually presented a
  // token, so a wrong OTP code never trips it.)
  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  // Restore the saved session on launch so a returning customer skips login —
  // but VERIFY it with the server first. A stale/revoked token must land on
  // sign-in, not a broken "signed in" shell where browsing and ordering 401.
  useEffect(() => {
    void (async () => {
      // Restore the saved language BEFORE the first screen renders (the splash
      // below covers this while token === undefined), so it never flashes the default.
      await restoreLanguage();
      const [saved, savedArea] = await Promise.all([loadToken(), loadArea()]);
      setArea(savedArea);

      if (!saved) {
        setToken(null);
        return;
      }
      setAuthToken(saved);
      try {
        // Prove the token is still valid AND belongs to a customer before trusting
        // it. A shop/admin token can browse but 403s at checkout — catch it here
        // so the tester lands on a clean sign-in, not a shell that fails to order.
        const me = await api.me();
        if (me.role !== "CUSTOMER") {
          endSession("wrongRole");
          return;
        }
        setToken(saved);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          // Expired/revoked — the 401 handler above has already cleared it; make
          // sure we render sign-in (with the "session ended" notice).
          setToken(null);
        } else {
          // Couldn't verify (offline / server still starting). Trust the saved
          // token; the shop list has its own connection-retry UI.
          setToken(saved);
        }
      }
    })();
  }, []);

  async function handleSignedIn(newToken: string) {
    setLoginNotice(null);
    setAuthToken(newToken);
    await saveToken(newToken);
    setToken(newToken);

    // Register for order notifications AFTER sign-in, deliberately.
    //
    // Asking a stranger for notification permission before they have an order
    // to be notified about gets refused on reflex — and on iOS that refusal is
    // permanent, so the customer would never learn their order was cancelled.
    //
    // Not awaited, and it cannot throw (see src/push.ts): a customer who
    // refuses notifications, or whose device cannot get a token, must still get
    // straight into the shop. Push is how we reach them, not how they shop.
    void registerForPush();
  }

  async function handleSignOut() {
    // Before clearing the token — the API call needs it to identify the device.
    // Best-effort: a failure must not trap someone in a signed-in state.
    await unregisterFromPush().catch(() => undefined);

    setAuthToken(null);
    await clearToken();
    setSelectedShop(null);
    setToken(null);
  }

  async function handleAreaChosen(chosen: string) {
    setArea(chosen);
    await saveArea(chosen);
  }

  return (
    <ErrorBoundary>
      {token === undefined ? (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color={colors.brand} />
          <StatusBar style="light" />
        </View>
      ) : (
        <View style={styles.flex}>
          {!token ? (
            <LoginScreen onSignedIn={handleSignedIn} notice={loginNotice} />
          ) : selectedShop ? (
            <BrowseScreen shop={selectedShop} onBack={() => setSelectedShop(null)} />
          ) : (
            <ShopsScreen
              onSelectShop={setSelectedShop}
              onSignOut={handleSignOut}
              place={place}
              onPlaceChange={setPlace}
              savedArea={area}
              onAreaChosen={handleAreaChosen}
            />
          )}
          {/* Shop list and storefront both have dark headers → light bar. */}
          <StatusBar style={token ? "light" : "auto"} />
        </View>
      )}
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  splash: {
    flex: 1,
    backgroundColor: colors.brandDarker,
    alignItems: "center",
    justifyContent: "center",
  },
});
