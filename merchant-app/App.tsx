import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { api, setAuthToken, type MerchantProfile } from "./src/api";
import { ErrorBoundary } from "./src/ErrorBoundary";
import { LoginScreen } from "./src/LoginScreen";
import { OrdersScreen } from "./src/OrdersScreen";
import { ProductsScreen } from "./src/ProductsScreen";
// Safe on the startup path: push.ts require()s expo-notifications lazily inside
// its functions and only imports Platform + api at module scope.
import { registerForPush, unregisterFromPush } from "./src/push";
import { clearToken, loadToken, saveToken } from "./src/storage";
import { colors, font, radius, shadow, space } from "./src/theme";

type Tab = "orders" | "products";

export default function App() {
  // undefined = still restoring; null = signed out.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState<string | null>(null);
  const [profile, setProfile] = useState<MerchantProfile | null>(null);
  const [tab, setTab] = useState<Tab>("orders");
  const [pending, setPending] = useState(0);

  // Restore a saved session on launch. The role is not persisted separately —
  // it is re-read from the server via the profile call, which also proves the
  // token is still a valid MERCHANT token.
  useEffect(() => {
    void (async () => {
      const saved = await loadToken();
      setAuthToken(saved);
      setToken(saved);
    })();
  }, []);

  // Once we have a token, load the profile. A non-merchant token (customer or
  // admin) fails here with a 403 — which is exactly how we detect "wrong app"
  // without trusting anything the client says about its own role.
  const refreshProfile = useCallback(async () => {
    try {
      setProfile(await api.profile());
      setRole("MERCHANT");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        // A real, signed-in user — just not a merchant.
        setRole("NOT_MERCHANT");
      } else if (status === 401) {
        // Token expired/revoked — drop it cleanly.
        await signOut();
      } else {
        // A transient error: keep the merchant in, they can retry.
        setRole("MERCHANT");
      }
    }
  }, []);

  useEffect(() => {
    if (token) void refreshProfile();
  }, [token, refreshProfile]);

  async function handleSignedIn(result: { token: string; role: string }) {
    setAuthToken(result.token);
    await saveToken(result.token);
    setToken(result.token);
    // Register for new-order push AFTER sign-in (asking earlier gets refused on
    // reflex; on iOS that refusal is permanent). Never awaited, cannot throw.
    if (result.role === "MERCHANT") void registerForPush();
  }

  async function signOut() {
    await unregisterFromPush().catch(() => undefined);
    setAuthToken(null);
    await clearToken();
    setToken(null);
    setRole(null);
    setProfile(null);
    setTab("orders");
    setPending(0);
  }

  // --- Render ---

  if (token === undefined) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.card} />
        <StatusBar style="light" />
      </View>
    );
  }

  if (!token) {
    return (
      <ErrorBoundary>
        <LoginScreen onSignedIn={handleSignedIn} />
        <StatusBar style="auto" />
      </ErrorBoundary>
    );
  }

  // Signed in, but not as a merchant — this app is for shops only.
  if (role === "NOT_MERCHANT") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.wrongApp}>
          <Text style={styles.wrongAppTitle}>This app is for shop owners</Text>
          <Text style={styles.wrongAppBody}>
            This phone number is not registered as a shop. If you run a shop, sign out and tap
            “New shop? Register here” on the sign-in screen. Customers should use the Half-Dinar
            Shops customer app instead.
          </Text>
          <TouchableOpacity style={styles.button} onPress={signOut} testID="wrong-app-signout">
            <Text style={styles.buttonText}>Sign out</Text>
          </TouchableOpacity>
        </SafeAreaView>
        <StatusBar style="dark" />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SafeAreaView style={styles.flex}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.brand} testID="merchant-header">
              {profile?.shopName ?? "Half-Dinar Merchant"}
            </Text>
            {profile && (
              <Text style={styles.headerMeta}>
                {profile.productCount} products · {profile.status}
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={signOut} testID="sign-out">
            <Text style={styles.signOut}>Sign out</Text>
          </TouchableOpacity>
        </View>

        {profile?.status === "PENDING" && (
          <View style={styles.pendingBanner} testID="pending-approval">
            <Text style={styles.pendingBannerText}>
              Your shop is awaiting admin approval. Build your product list now — customers see it once
              you are approved.
            </Text>
          </View>
        )}

        <View style={styles.tabs}>
          <TouchableOpacity
            style={[styles.tab, tab === "orders" && styles.tabActive]}
            onPress={() => setTab("orders")}
            testID="tab-orders"
          >
            <Text style={[styles.tabText, tab === "orders" && styles.tabTextActive]}>Orders</Text>
            {pending > 0 && (
              <View style={styles.badge} testID="pending-badge">
                <Text style={styles.badgeText}>{pending}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === "products" && styles.tabActive]}
            onPress={() => setTab("products")}
            testID="tab-products"
          >
            <Text style={[styles.tabText, tab === "products" && styles.tabTextActive]}>Products</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.flex}>
          {tab === "orders" ? (
            <OrdersScreen onPendingChange={setPending} />
          ) : (
            <ProductsScreen />
          )}
        </View>
        <StatusBar style="light" />
      </SafeAreaView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  splash: {
    flex: 1,
    backgroundColor: colors.brandDarker,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    backgroundColor: colors.brandDarker,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  headerText: { flex: 1 },
  brand: { ...font.h1, color: colors.card },
  headerMeta: { ...font.small, color: colors.brandBorder, marginTop: 2 },
  signOut: { ...font.bodyStrong, color: colors.card },
  pendingBanner: {
    backgroundColor: colors.warnSoft,
    padding: space.md,
  },
  pendingBannerText: { ...font.small, color: colors.warn },
  tabs: { flexDirection: "row", backgroundColor: colors.card, ...shadow.card },
  tab: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: space.md,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    gap: space.sm,
  },
  tabActive: { borderBottomColor: colors.brand },
  tabText: { ...font.bodyStrong, color: colors.muted },
  tabTextActive: { color: colors.brand },
  badge: {
    backgroundColor: colors.danger,
    borderRadius: radius.pill,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: "#fff", ...font.tiny },
  wrongApp: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: space.xl,
    justifyContent: "center",
  },
  wrongAppTitle: { ...font.h1, color: colors.ink, marginBottom: space.md, textAlign: "center" },
  wrongAppBody: { ...font.body, color: colors.muted, textAlign: "center", marginBottom: space.xl },
  button: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
