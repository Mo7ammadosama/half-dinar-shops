import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { setAuthToken, type Shop } from "./src/api";
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
import { colors } from "./src/theme";

export default function App() {
  // null = not signed in; undefined = still restoring the saved session.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [area, setArea] = useState<string | null>(null);

  // Delivery location, lifted here so it survives navigating in and out of a
  // shop. The shop list uses it to sort shops by distance.
  const [place, setPlace] = useState<Place>({ kind: "unset" });
  // Which shop the customer has opened; null = still on the shop list.
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);

  // Restore the saved session on launch so a returning customer skips login.
  useEffect(() => {
    void (async () => {
      const [saved, savedArea] = await Promise.all([loadToken(), loadArea()]);
      setAuthToken(saved);
      setArea(savedArea);
      setToken(saved);
    })();
  }, []);

  async function handleSignedIn(newToken: string) {
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
            <LoginScreen onSignedIn={handleSignedIn} />
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
