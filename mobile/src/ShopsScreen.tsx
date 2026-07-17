/**
 * The shop list — the customer's landing screen after signing in.
 *
 * Shows every shop the customer is allowed to see (the server restricts this to
 * APPROVED shops), sorted by how near they are once a location is known. Distance
 * is computed on the device from each shop's coordinates; the API contract is
 * unchanged. Location is NEVER a gate: with no location the list still renders,
 * ordered by name, with a prompt to set one — see `src/location.ts`.
 *
 * Tapping a shop opens its storefront (BrowseScreen).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { api, type Shop } from "./api";
import {
  distanceKm,
  MANUAL_AREAS,
  placeCoords,
  requestLocation,
  type Place,
} from "./location";
import { OrdersScreen } from "./OrdersScreen";
import { shopMonogram } from "./shopVisuals";
import { colors, font, radius, shadow, space } from "./theme";

/** A shop plus its computed distance (km) from the customer, when known. */
type RankedShop = Shop & { distance: number | null };

export function ShopsScreen({
  onSelectShop,
  onSignOut,
  place,
  onPlaceChange,
  savedArea,
  onAreaChosen,
}: {
  onSelectShop: (shop: Shop) => void;
  onSignOut: () => void;
  place: Place;
  onPlaceChange: (place: Place) => void;
  savedArea: string | null;
  onAreaChosen: (area: string) => void;
}) {
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [locationBusy, setLocationBusy] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setShops(await api.listShops());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  // Restore a saved area on first mount so distance works for returning users.
  useEffect(() => {
    if (place.kind === "unset" && savedArea) onPlaceChange({ kind: "area", area: savedArea });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Shops ranked by distance when a location is known, else alphabetical. */
  const ranked: RankedShop[] = useMemo(() => {
    const coords = placeCoords(place);
    const withDistance: RankedShop[] = shops.map((s) => ({
      ...s,
      distance: coords
        ? distanceKm(coords, { latitude: s.locationLat, longitude: s.locationLng })
        : null,
    }));

    return withDistance.sort((a, b) => {
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
      if (a.distance !== null) return -1;
      if (b.distance !== null) return 1;
      return a.shopName.localeCompare(b.shopName);
    });
  }, [shops, place]);

  const hasLocation = placeCoords(place) !== null;

  async function handleUseLocation() {
    setLocationBusy(true);
    const result = await requestLocation();
    setLocationBusy(false);

    if (result.kind === "coords") {
      onPlaceChange({ kind: "gps", latitude: result.latitude, longitude: result.longitude });
      return;
    }
    setAreaPickerOpen(true);
  }

  function chooseArea(area: string) {
    onPlaceChange({ kind: "area", area });
    onAreaChosen(area);
    setAreaPickerOpen(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function placeLabel(): string {
    if (place.kind === "area") return place.area;
    if (place.kind === "gps") return "Your location";
    return "Set delivery location";
  }

  return (
    <View style={styles.flex}>
      {/* Brand header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.brand}>
            Half-Dinar <Text style={styles.brandAccent}>Shops</Text>
          </Text>
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setOrdersOpen(true)} testID="open-orders">
              <Text style={styles.headerLink}>My orders</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSignOut} testID="sign-out">
              <Text style={styles.signOut}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.tagline}>Everyday shops near you · pay on delivery</Text>

        <TouchableOpacity
          style={styles.placeRow}
          onPress={handleUseLocation}
          disabled={locationBusy}
          testID="location-button"
          activeOpacity={0.8}
        >
          <Text style={styles.placePin}>📍</Text>
          <Text style={styles.placeText} testID="place-label" numberOfLines={1}>
            {locationBusy ? "Finding you…" : placeLabel()}
          </Text>
          <Text style={styles.placeChange}>{hasLocation ? "Change" : "Set"}</Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errorBanner} testID="shops-error">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleRefresh}>
            <Text style={styles.retry}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>Finding shops…</Text>
        </View>
      ) : shops.length === 0 ? (
        <View style={styles.centered} testID="no-shop">
          <Text style={styles.emptyEmoji}>🛍️</Text>
          <Text style={styles.emptyTitle}>No shops open yet</Text>
          <Text style={styles.emptyBody}>
            We're adding shops in your area. Please check back soon.
          </Text>
        </View>
      ) : (
        <FlatList
          data={ranked}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.listHeadRow}>
              <Text style={styles.listHead}>
                {shops.length} {shops.length === 1 ? "shop" : "shops"}
                {hasLocation ? " · nearest first" : ""}
              </Text>
              {!hasLocation && (
                <Text style={styles.listHint}>Set your location to sort by distance</Text>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.shopCard}
              onPress={() => onSelectShop(item)}
              testID="shop-card"
              activeOpacity={0.85}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{shopMonogram(item.shopName)}</Text>
              </View>

              <View style={styles.shopBody}>
                <Text style={styles.shopName} numberOfLines={1} testID="shop-card-name">
                  {item.shopName}
                </Text>
                <Text style={styles.shopMeta} numberOfLines={1}>
                  Open {item.openingHours} · {item.productCount} items
                </Text>
                {item.distance !== null && (
                  <View style={styles.distancePill}>
                    <Text style={styles.distanceText} testID="shop-distance">
                      {item.distance.toFixed(1)} km away
                    </Text>
                  </View>
                )}
              </View>

              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <OrdersScreen visible={ordersOpen} onClose={() => setOrdersOpen(false)} />

      {/* Manual fallback whenever GPS is refused or unavailable. */}
      <Modal
        visible={areaPickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setAreaPickerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Choose your area</Text>
            <Text style={styles.modalBody}>
              We couldn't use your location, so pick the area you'd like delivery to.
            </Text>

            <ScrollView style={styles.areaList}>
              {MANUAL_AREAS.map((area) => (
                <TouchableOpacity
                  key={area}
                  style={styles.areaRow}
                  onPress={() => chooseArea(area)}
                  testID={`area-${area}`}
                >
                  <Text style={styles.areaText}>{area}</Text>
                  <Text style={styles.areaPin}>📍</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setAreaPickerOpen(false)}
              testID="area-cancel"
            >
              <Text style={styles.modalCloseText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl },
  loadingText: { marginTop: space.md, color: colors.muted, ...font.small },

  header: {
    backgroundColor: colors.brandDarker,
    paddingTop: 54,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { ...font.h1, color: "#ffffff" },
  brandAccent: { color: "#5eead4" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.lg },
  headerLink: { color: "#a7f3d0", ...font.small, fontWeight: "700" },
  signOut: { color: "#7dd3c8", ...font.small, fontWeight: "600" },
  tagline: { color: "#99f6e4", ...font.small, marginTop: 3, opacity: 0.9 },

  placeRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: space.md,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  placePin: { fontSize: 14 },
  placeText: { flex: 1, marginLeft: 8, color: "#ffffff", ...font.small, fontWeight: "700" },
  placeChange: { color: "#5eead4", ...font.small, fontWeight: "800" },

  errorBanner: {
    backgroundColor: colors.dangerSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.dangerBorder,
    padding: space.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  errorText: { color: colors.danger, ...font.small, flex: 1 },
  retry: { ...font.small, color: colors.danger, fontWeight: "800" },

  listContent: { padding: space.md, paddingBottom: space.xxl },
  listHeadRow: { paddingHorizontal: space.xs, paddingBottom: space.sm, paddingTop: space.xs },
  listHead: { ...font.h3, color: colors.inkSoft },
  listHint: { ...font.small, color: colors.muted, marginTop: 2 },

  shopCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow.card,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { ...font.h1, color: colors.brand },
  shopBody: { flex: 1, marginLeft: space.md },
  shopName: { ...font.h2, color: colors.ink },
  shopMeta: { ...font.small, color: colors.muted, marginTop: 2 },
  distancePill: {
    alignSelf: "flex-start",
    marginTop: 6,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  distanceText: { ...font.tiny, color: colors.accent },
  chevron: { fontSize: 26, color: colors.faint, marginLeft: space.sm, fontWeight: "400" },

  emptyEmoji: { fontSize: 40, marginBottom: space.sm },
  emptyTitle: { ...font.h2, color: colors.ink },
  emptyBody: { ...font.small, color: colors.muted, marginTop: 4, textAlign: "center" },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.xl,
    paddingTop: space.md,
    maxHeight: "72%",
  },
  modalHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    marginBottom: space.md,
  },
  modalTitle: { ...font.h1, color: colors.ink },
  modalBody: { ...font.small, color: colors.muted, marginTop: 4, marginBottom: space.md },
  areaList: { flexGrow: 0 },
  areaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  areaText: { ...font.body, fontWeight: "600", color: colors.ink },
  areaPin: { fontSize: 13, opacity: 0.6 },
  modalClose: { paddingVertical: space.lg, alignItems: "center" },
  modalCloseText: { ...font.body, color: colors.muted, fontWeight: "700" },
});
