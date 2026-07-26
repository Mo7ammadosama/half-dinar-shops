import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { api, setAuthToken, setUnauthorizedHandler, type Shop } from "./src/api";
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
  // True when we returned to sign-in because the saved session was rejected
  // (expired/revoked), so the login screen can say why rather than silently
  // showing a fresh form.
  const [sessionEnded, setSessionEnded] = useState(false);

  // Delivery location, lifted here so it survives navigating in and out of a
  // shop. The shop list uses it to sort shops by distance.
  const [place, setPlace] = useState<Place>({ kind: "unset" });
  // Which shop the customer has opened; null = still on the shop list.
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);

  /**
   * Ends a session that the SERVER rejected (a 401 on a request we made with a
   * token). Deliberately makes NO API calls — the 401 is exactly what brought us
   * here, so calling the API again (e.g. to unregister push) would only 401 in a
   * loop. Clears the dead token and drops the customer on sign-in with a notice.
   */
  const endExpiredSession = useCallback(() => {
    setAuthToken(null);
    void clearToken();
    setSelectedShop(null);
    setSessionEnded(true);
    setToken(null);
  }, []);

  // Any request made WITH a token that comes back 401 means the saved session is
  // dead — clear it and return to sign-in instead of trapping the customer on a
  // "signed in" screen where nothing loads. (The api layer gates this to 401s
  // that actually presented a token, so a wrong OTP code never trips it.)
  useEffect(() => {
    setUnauthorizedHandler(endExpiredSession);
    return () => setUnauthorizedHandler(null);
  }, [endExpiredSession]);

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
        // Prove the token is still valid before trusting it.
        await api.me();
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
    setSessionEnded(false);
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
            <LoginScreen onSignedIn={handleSignedIn} sessionEnded={sessionEnded} />
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
