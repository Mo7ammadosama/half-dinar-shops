/**
 * The customer's orders.
 *
 * Shows live status, lets them cancel (with a warning once the shop has started
 * picking), and handles the out-of-stock case: the shop flags an item, the
 * customer sees what the new total would be, and only their acceptance changes
 * what they pay.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api, type Order, type OrderStatus, type OrderSummary } from "./api";
import { colors } from "./theme";

/**
 * Opens the phone dialler.
 *
 * `tel:` is the whole feature — the app hands off to the phone rather than
 * carrying calls itself.
 */
function callNumber(phone: string) {
  void Linking.openURL(`tel:${phone}`);
}

/** Plain-language status, written for a shopper rather than a developer. */
const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "Waiting for the shop to confirm",
  CONFIRMED: "Confirmed by the shop",
  PREPARING: "The shop is picking your items",
  DELIVERING: "On its way to you",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const STATUS_STYLE: Record<OrderStatus, { bg: string; fg: string }> = {
  PENDING: { bg: colors.warnSoft, fg: colors.warn },
  CONFIRMED: { bg: "#dbeafe", fg: "#1e40af" },
  PREPARING: { bg: "#dbeafe", fg: "#1e40af" },
  DELIVERING: { bg: "#ede9fe", fg: "#5b21b6" },
  DELIVERED: { bg: "#d1fae5", fg: "#065f46" },
  CANCELLED: { bg: "#fee2e2", fg: "#991b1b" },
};

/**
 * Confirms an action with the customer.
 *
 * React Native's Alert is a no-op on web, so window.confirm is used there —
 * otherwise the warning the spec requires would silently not appear.
 */
async function confirmAction(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Keep my order", style: "cancel", onPress: () => resolve(false) },
      { text: "Cancel order", style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}

export function OrdersScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrders(await api.listOrders());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [visible, load]);

  async function open(id: string) {
    setError(null);
    try {
      setSelected(await api.getOrder(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    if (selected) await open(selected.id);
    setRefreshing(false);
  }

  async function handleCancel(order: Order) {
    // The spec requires a warning once the shop is already working on it.
    if (order.cancelRequiresWarning) {
      const ok = await confirmAction(
        "The shop has already started",
        "Your items are being picked right now. Are you sure you want to cancel?",
      );
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    try {
      setSelected(await api.cancelOrder(order.id));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptChanges(order: Order) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await api.acceptOrderChanges(order.id));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReview(order: Order) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await api.reviewOrder(order.id, rating, comment));
      setRating(0);
      setComment("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.flex}>
        <View style={styles.header}>
          <Text style={styles.title}>Your orders</Text>
          <TouchableOpacity onPress={selected ? () => setSelected(null) : onClose} testID="orders-close">
            <Text style={styles.close}>{selected ? "Back" : "Close"}</Text>
          </TouchableOpacity>
        </View>

        {error && (
          <View style={styles.errorBanner} testID="orders-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand} />
          </View>
        ) : selected ? (
          <ScrollView
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          >
            <View style={[styles.statusPill, { backgroundColor: STATUS_STYLE[selected.status].bg }]}>
              <Text style={[styles.statusText, { color: STATUS_STYLE[selected.status].fg }]} testID="detail-status">
                {STATUS_LABEL[selected.status]}
              </Text>
            </View>

            {selected.cancellationReason && selected.status === "CANCELLED" && (
              <View style={styles.reasonBox} testID="detail-cancel-reason">
                <Text style={styles.reasonText}>
                  {selected.cancelledBy === "MERCHANT"
                    ? `${selected.shop.shopName} cancelled: ${selected.cancellationReason}`
                    : selected.cancellationReason}
                </Text>
              </View>
            )}

            {selected.delivery && selected.status !== "CANCELLED" && (
              <View style={styles.driverBox} testID="driver-box">
                <Text style={styles.driverStatus} testID="driver-status">
                  {selected.delivery.statusLabel}
                </Text>
                <Text style={styles.driverName} testID="driver-name">
                  {selected.delivery.captainName}
                </Text>
                {/* The driver's real number, shown in full — no masking. */}
                <Text style={styles.driverPhone} testID="driver-phone">
                  {selected.delivery.captainPhone}
                </Text>
              </View>
            )}

            {/*
              Call buttons appear only when the server actually sends a number —
              which it does only inside the right window. The shop while they are
              preparing; the driver while they are carrying it.
            */}
            {selected.contact.shopPhone && (
              <TouchableOpacity
                style={styles.callButton}
                onPress={() => callNumber(selected.contact.shopPhone!)}
                testID="call-shop"
              >
                <Text style={styles.callButtonText}>
                  Call {selected.shop.shopName} · {selected.contact.shopPhone}
                </Text>
              </TouchableOpacity>
            )}

            {selected.contact.driverPhone && (
              <TouchableOpacity
                style={styles.callButton}
                onPress={() => callNumber(selected.contact.driverPhone!)}
                testID="call-driver"
              >
                <Text style={styles.callButtonText}>
                  Call {selected.contact.driverName} · {selected.contact.driverPhone}
                </Text>
              </TouchableOpacity>
            )}

            {selected.hasUnavailableItems && selected.status !== "CANCELLED" && (
              <View style={styles.changesBox} testID="unavailable-notice">
                <Text style={styles.changesTitle}>Some items are out of stock</Text>
                <Text style={styles.changesBody}>
                  {selected.unavailableItemNames.join(", ")}
                </Text>
                <Text style={styles.changesBody}>
                  Remove them and your total becomes{" "}
                  <Text style={styles.changesStrong} testID="revised-total">
                    {selected.revisedTotal} JOD
                  </Text>
                  .
                </Text>
                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => handleAcceptChanges(selected)}
                  disabled={busy}
                  testID="accept-changes"
                >
                  <Text style={styles.acceptButtonText}>Remove them and continue</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.card}>
              {selected.items.map((item) => (
                <View key={item.id} style={styles.row} testID="detail-item">
                  <Text
                    style={[styles.rowName, item.status === "UNAVAILABLE" && styles.struck]}
                    testID={`detail-item-${item.name}`}
                  >
                    {item.quantity} × {item.name}
                    {item.status === "UNAVAILABLE" ? "  (out of stock)" : ""}
                  </Text>
                  <Text style={styles.rowValue}>{item.lineTotal} JOD</Text>
                </View>
              ))}

              <View style={[styles.row, styles.divider]}>
                <Text style={styles.rowLabel}>Delivery</Text>
                <Text style={styles.rowValue}>{selected.deliveryFee} JOD</Text>
              </View>
              <View style={[styles.row, styles.divider]}>
                <Text style={styles.totalLabel}>Total (cash)</Text>
                <Text style={styles.totalValue} testID="detail-total">
                  {selected.totalPrice} JOD
                </Text>
              </View>
            </View>

            {/* Reviews: only once it actually arrived, and only once. */}
            {selected.review && (
              <View style={styles.reviewBox} testID="existing-review">
                <Text style={styles.reviewTitle}>You rated this order</Text>
                <Text style={styles.reviewStars} testID="review-stars">
                  {"★".repeat(selected.review.rating)}
                  {"☆".repeat(5 - selected.review.rating)}
                </Text>
                {selected.review.comment && (
                  <Text style={styles.reviewComment}>{selected.review.comment}</Text>
                )}
              </View>
            )}

            {selected.canReview && (
              <View style={styles.reviewBox} testID="review-form">
                <Text style={styles.reviewTitle}>How was it?</Text>
                <View style={styles.starRow}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <TouchableOpacity
                      key={star}
                      onPress={() => setRating(star)}
                      testID={`star-${star}`}
                    >
                      <Text style={[styles.star, star <= rating && styles.starOn]}>
                        {star <= rating ? "★" : "☆"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.reviewInput}
                  value={comment}
                  onChangeText={setComment}
                  placeholder="Anything to add? (optional)"
                  placeholderTextColor={colors.muted}
                  testID="review-comment"
                />
                <TouchableOpacity
                  style={[styles.acceptButton, (busy || rating === 0) && styles.disabled]}
                  onPress={() => handleReview(selected)}
                  disabled={busy || rating === 0}
                  testID="submit-review"
                >
                  <Text style={styles.acceptButtonText}>Send review</Text>
                </TouchableOpacity>
              </View>
            )}

            {selected.canCancel ? (
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => handleCancel(selected)}
                disabled={busy}
                testID="cancel-order"
              >
                <Text style={styles.cancelButtonText}>
                  {busy ? "Cancelling…" : "Cancel this order"}
                </Text>
              </TouchableOpacity>
            ) : (
              selected.cancelBlockedReason && (
                <Text style={styles.blocked} testID="cancel-blocked">
                  {selected.cancelBlockedReason}
                </Text>
              )
            )}
          </ScrollView>
        ) : orders.length === 0 ? (
          <View style={styles.centered} testID="no-orders">
            <Text style={styles.emptyTitle}>No orders yet</Text>
            <Text style={styles.emptyBody}>Your orders will appear here.</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          >
            {orders.map((o) => (
              <TouchableOpacity
                key={o.id}
                style={styles.orderRow}
                onPress={() => open(o.id)}
                testID="order-row"
              >
                <View style={styles.orderBody}>
                  <Text style={styles.orderShop}>{o.shopName}</Text>
                  <Text style={styles.orderMeta}>
                    {o.itemCount} item{o.itemCount === 1 ? "" : "s"} ·{" "}
                    {new Date(o.createdAt).toLocaleString()}
                  </Text>
                  <View style={[styles.statusPillSmall, { backgroundColor: STATUS_STYLE[o.status].bg }]}>
                    <Text style={[styles.statusTextSmall, { color: STATUS_STYLE[o.status].fg }]} testID="row-status">
                      {STATUS_LABEL[o.status]}
                    </Text>
                  </View>
                </View>
                <Text style={styles.orderTotal}>{o.totalPrice} JOD</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  header: {
    backgroundColor: colors.brandDarker,
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 18, fontWeight: "800", color: "#ffffff" },
  close: { color: "#a7f3d0", fontWeight: "700", fontSize: 14 },
  errorBanner: { backgroundColor: "#fef2f2", padding: 12 },
  errorText: { color: colors.danger, fontSize: 13 },
  list: { padding: 12 },

  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  orderBody: { flex: 1 },
  orderShop: { fontSize: 15, fontWeight: "700", color: colors.ink },
  orderMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  orderTotal: { fontSize: 15, fontWeight: "800", color: colors.brand },

  statusPill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  statusText: { fontSize: 12, fontWeight: "800" },
  statusPillSmall: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 6,
  },
  statusTextSmall: { fontSize: 11, fontWeight: "800" },

  reasonBox: {
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  reasonText: { color: colors.danger, fontSize: 13 },

  driverBox: {
    backgroundColor: "#ede9fe",
    borderWidth: 1,
    borderColor: "#ddd6fe",
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  driverStatus: { fontSize: 14, fontWeight: "800", color: "#5b21b6" },
  driverName: { fontSize: 14, color: "#5b21b6", marginTop: 4 },
  driverPhone: { fontSize: 14, color: "#5b21b6", fontWeight: "700", marginTop: 2 },

  changesBox: {
    backgroundColor: colors.warnSoft,
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  changesTitle: { fontSize: 14, fontWeight: "800", color: colors.warn },
  changesBody: { fontSize: 13, color: colors.warn, marginTop: 4 },
  changesStrong: { fontWeight: "800" },
  acceptButton: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 10,
  },
  acceptButtonText: { color: "#fff", fontWeight: "800", fontSize: 14 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    marginTop: 10,
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 8 },
  rowName: { fontSize: 14, color: colors.ink, flex: 1 },
  struck: { textDecorationLine: "line-through", color: colors.muted },
  rowLabel: { fontSize: 14, color: colors.muted },
  rowValue: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  totalLabel: { fontSize: 15, fontWeight: "800", color: colors.ink },
  totalValue: { fontSize: 15, fontWeight: "800", color: colors.brand },

  callButton: {
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: "#a7f3d0",
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 10,
  },
  callButtonText: { color: colors.ok, fontWeight: "800", fontSize: 14 },

  reviewBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
  },
  reviewTitle: { fontSize: 14, fontWeight: "800", color: colors.ink },
  reviewStars: { fontSize: 22, color: "#f59e0b", marginTop: 6 },
  reviewComment: { fontSize: 13, color: colors.muted, marginTop: 6 },
  starRow: { flexDirection: "row", gap: 6, marginTop: 8, marginBottom: 10 },
  star: { fontSize: 30, color: colors.line },
  starOn: { color: "#f59e0b" },
  reviewInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  disabled: { opacity: 0.5 },

  cancelButton: {
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fef2f2",
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 14,
  },
  cancelButtonText: { color: colors.danger, fontWeight: "800", fontSize: 14 },
  blocked: { fontSize: 12, color: colors.muted, textAlign: "center", marginTop: 14 },

  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  emptyBody: { fontSize: 13, color: colors.muted, marginTop: 4 },
});
