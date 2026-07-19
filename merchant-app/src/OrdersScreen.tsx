/**
 * Merchant order handling — the shopkeeper's working screen.
 *
 * See new orders, tick items off as picked (or mark them out of stock), confirm,
 * start picking, cancel with a mandatory reason, and hand off to a delivery
 * driver by name. All of the cancellation/out-of-stock rules are enforced on the
 * server (order-policy.ts); this screen only ever offers actions the server will
 * accept, and shows the server's response.
 *
 * WHY POLL, NOT SSE: the dashboard uses a fetch-streamed SSE connection for
 * instant alerts, but React Native's fetch does not expose a readable response
 * body, so that stream cannot be consumed on a device. The list therefore polls
 * every 10 seconds — and the CLOSED-app case is covered by a real push
 * notification the server sends on every new order (the merchant B6b work). The
 * poll makes an open app current; the push reaches a pocketed phone.
 *
 * Phase 11 (daily-use polish): a status filter (New / Active / Done) with live
 * counts so the shopkeeper sees where the work is; relative timestamps with an
 * "waiting Nm" urgency flag on orders left unconfirmed; pull-to-refresh plus a
 * Refresh button and a "last updated" line; and a success toast after every
 * action so nothing completes silently.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  api,
  type DeliveryStatus,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
} from "./api";
import { Chips } from "./Chips";
import { Toast, type ToastState } from "./Toast";
import { relativeTime, minutesSince } from "./time";
import { colors, font, radius, shadow, space } from "./theme";

const POLL_MS = 10_000;
/** A PENDING order older than this many minutes is flagged as waiting. */
const URGENT_MINUTES = 5;

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "New — needs confirming",
  CONFIRMED: "Confirmed",
  PREPARING: "Picking items",
  DELIVERING: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  ASSIGNED: "Driver assigned",
  PICKED_UP: "Driver collected it",
  ON_WAY: "On the way",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
};

const NEXT_DELIVERY_STEPS: Record<DeliveryStatus, DeliveryStatus[]> = {
  ASSIGNED: ["PICKED_UP"],
  PICKED_UP: ["ON_WAY", "DELIVERED"],
  ON_WAY: ["DELIVERED"],
  DELIVERED: [],
  FAILED: [],
};

type OrderFilter = "all" | "new" | "active" | "done";

const FILTER_GROUPS: Record<Exclude<OrderFilter, "all">, OrderStatus[]> = {
  new: ["PENDING"],
  active: ["CONFIRMED", "PREPARING", "DELIVERING"],
  done: ["DELIVERED", "CANCELLED"],
};

function inFilter(status: OrderStatus, filter: OrderFilter): boolean {
  if (filter === "all") return true;
  return FILTER_GROUPS[filter].includes(status);
}

export function OrdersScreen({ onPendingChange }: { onPendingChange?: (n: number) => void }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [toast, setToast] = useState<ToastState>(null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [captainName, setCaptainName] = useState("");
  const [captainPhone, setCaptainPhone] = useState("");
  const [failing, setFailing] = useState(false);
  const [failNote, setFailNote] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await api.listOrders();
      setOrders(list);
      setLastSync(Date.now());
      onPendingChange?.(list.filter((o) => o.status === "PENDING").length);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [onPendingChange]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Counts per filter, for the chip badges — computed from the full list so the
  // counts stay correct whichever filter is active.
  const counts = useMemo(
    () => ({
      all: orders.length,
      new: orders.filter((o) => inFilter(o.status, "new")).length,
      active: orders.filter((o) => inFilter(o.status, "active")).length,
      done: orders.filter((o) => inFilter(o.status, "done")).length,
    }),
    [orders],
  );

  // Pending orders first (oldest waiting at the top — that is the most urgent),
  // then everything else newest-first.
  const visibleOrders = useMemo(() => {
    const list = orders.filter((o) => inFilter(o.status, filter));
    return [...list].sort((a, b) => {
      const aPending = a.status === "PENDING";
      const bPending = b.status === "PENDING";
      if (aPending !== bPending) return aPending ? -1 : 1;
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      return aPending ? at - bt : bt - at;
    });
  }, [orders, filter]);

  async function open(id: string) {
    setError(null);
    setCancelling(false);
    setFailing(false);
    try {
      setSelected(await api.getOrder(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Runs an action, refreshes the detail and the list, surfaces errors. */
  async function act(fn: () => Promise<OrderDetail>, successMsg?: string) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await fn());
      await load();
      if (successMsg) setToast({ message: successMsg, tone: "ok" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!selected) return;
    await act(() => api.cancelOrder(selected.id, cancelReason), "Order cancelled — the customer is notified");
    setCancelling(false);
    setCancelReason("");
  }

  // ---- Detail view ----
  if (selected) {
    const s = selected;
    const confirmedCount = s.items.filter((i) => i.status === "CONFIRMED").length;
    return (
      <View style={styles.flex}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {error && (
          <View style={styles.errorBox} testID="orders-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.detailHead}>
          <TouchableOpacity onPress={() => setSelected(null)} testID="close-detail">
            <Text style={styles.backLink}>‹ Back to orders</Text>
          </TouchableOpacity>
          <View style={styles.statusBadge} testID="detail-status">
            <Text style={styles.statusBadgeText}>{STATUS_LABEL[s.status]}</Text>
          </View>
        </View>

        <Text style={styles.detailTitle}>
          Order {s.customer.phoneNumber ?? `#${s.id.slice(0, 8)}`}
        </Text>
        <Text style={styles.detailSub} testID="detail-summary">
          Placed {relativeTime(s.createdAt)} · {s.items.length} item{s.items.length === 1 ? "" : "s"}
          {s.hasUnavailableItems ? ` · ${s.items.length - confirmedCount} out of stock` : ""}
        </Text>

        {s.cancellationReason && (
          <View style={styles.errorBox} testID="detail-cancel-reason">
            <Text style={styles.errorText}>
              Cancelled by {s.cancelledBy?.toLowerCase()}: {s.cancellationReason}
            </Text>
          </View>
        )}

        {/* Call the customer — only while actively working the order. The number
            is withheld by the server outside this window, so this only ever
            renders when there is a number to call. */}
        {["CONFIRMED", "PREPARING"].includes(s.status) && s.customer.phoneNumber && (
          <TouchableOpacity
            style={styles.callButton}
            onPress={() => Linking.openURL(`tel:${s.customer.phoneNumber}`)}
            testID="call-customer"
          >
            <Text style={styles.callButtonText}>📞 Call the customer · {s.customer.phoneNumber}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.card}>
          {s.items.map((item) => (
            <View key={item.id} style={styles.itemRow} testID="detail-item">
              <View style={styles.itemInfo}>
                <Text
                  style={[styles.itemName, item.status === "UNAVAILABLE" && styles.itemNameOut]}
                >
                  {item.name}
                </Text>
                <Text style={styles.itemMeta}>
                  {item.quantity} × {item.priceAtOrder} = {item.lineTotal} JOD
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.pill, item.status === "CONFIRMED" ? styles.pillOn : styles.pillOff]}
                disabled={busy || !["PENDING", "CONFIRMED", "PREPARING"].includes(s.status)}
                onPress={() =>
                  act(
                    () =>
                      api.setItemStatus(
                        s.id,
                        item.id,
                        item.status === "CONFIRMED" ? "UNAVAILABLE" : "CONFIRMED",
                      ),
                    item.status === "CONFIRMED"
                      ? `“${item.name}” marked out of stock`
                      : `“${item.name}” back in`,
                  )
                }
                testID={`item-toggle-${item.name}`}
              >
                <Text style={item.status === "CONFIRMED" ? styles.pillOnText : styles.pillOffText}>
                  {item.status === "CONFIRMED" ? "Got it" : "Out of stock"}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
          <Text style={styles.totals} testID="detail-totals">
            Delivery {s.deliveryFee} JOD · Total {s.totalPrice} JOD
            {s.hasUnavailableItems && (
              <Text testID="detail-revised">
                {"  "}· Revised {s.revisedTotal} JOD once the customer accepts the removals
              </Text>
            )}
          </Text>
        </View>

        <View style={styles.actionsCol}>
          {s.status === "PENDING" && (
            <TouchableOpacity
              style={[styles.button, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => act(() => api.confirmOrder(s.id), "Order confirmed")}
              testID="confirm-order"
            >
              <Text style={styles.buttonText}>Confirm order</Text>
            </TouchableOpacity>
          )}
          {s.status === "CONFIRMED" && (
            <TouchableOpacity
              style={[styles.button, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => act(() => api.startPreparing(s.id), "Now picking items")}
              testID="start-preparing"
            >
              <Text style={styles.buttonText}>Start picking</Text>
            </TouchableOpacity>
          )}
          {["CONFIRMED", "PREPARING"].includes(s.status) && !cancelling && (
            <TouchableOpacity
              style={styles.dangerButton}
              disabled={busy}
              onPress={() => setCancelling(true)}
              testID="cancel-order"
            >
              <Text style={styles.dangerButtonText}>Cancel order</Text>
            </TouchableOpacity>
          )}
        </View>

        {cancelling && (
          <View style={styles.card} testID="cancel-box">
            <Text style={styles.label}>Why are you cancelling? The customer will see this.</Text>
            <TextInput
              style={styles.input}
              value={cancelReason}
              onChangeText={setCancelReason}
              placeholder="e.g. We are closing early today"
              placeholderTextColor={colors.faint}
              testID="cancel-reason"
            />
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={[styles.dangerButton, (busy || cancelReason.trim().length < 3) && styles.buttonDisabled]}
                disabled={busy || cancelReason.trim().length < 3}
                onPress={handleCancel}
                testID="confirm-cancel"
              >
                <Text style={styles.dangerButtonText}>Cancel this order</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.ghostButton}
                onPress={() => {
                  setCancelling(false);
                  setCancelReason("");
                }}
                testID="abort-cancel"
              >
                <Text style={styles.ghostButtonText}>Keep the order</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Delivery — entered by hand; there is no captain app yet. */}
        {s.canAssignDelivery && (
          <View style={styles.card} testID="assign-delivery-box">
            <Text style={styles.cardTitle}>Send it out</Text>
            <Text style={styles.muted}>Type in who is taking it. The customer sees their name and number.</Text>
            <Text style={styles.label}>Driver's name</Text>
            <TextInput
              style={styles.input}
              value={captainName}
              onChangeText={setCaptainName}
              placeholder="Omar Al-Zoubi"
              placeholderTextColor={colors.faint}
              testID="captain-name"
            />
            <Text style={styles.label}>Driver's phone</Text>
            <TextInput
              style={styles.input}
              value={captainPhone}
              onChangeText={setCaptainPhone}
              placeholder="07 9112 2334"
              placeholderTextColor={colors.faint}
              keyboardType="phone-pad"
              testID="captain-phone"
            />
            <TouchableOpacity
              style={[
                styles.button,
                (busy || captainName.trim().length < 2 || captainPhone.trim().length < 9) &&
                  styles.buttonDisabled,
              ]}
              disabled={busy || captainName.trim().length < 2 || captainPhone.trim().length < 9}
              onPress={async () => {
                await act(() => api.assignDelivery(s.id, captainName, captainPhone), "Driver assigned");
                setCaptainName("");
                setCaptainPhone("");
              }}
              testID="assign-delivery"
            >
              <Text style={styles.buttonText}>Assign driver</Text>
            </TouchableOpacity>
          </View>
        )}

        {s.delivery && (
          <View style={styles.card} testID="delivery-box">
            <Text style={styles.cardTitle}>Delivery</Text>
            <Text style={styles.itemName} testID="delivery-captain">
              {s.delivery.captainName}
            </Text>
            <TouchableOpacity
              onPress={() => Linking.openURL(`tel:${s.delivery!.captainPhone}`)}
              testID="delivery-captain-phone"
            >
              <Text style={styles.linkAction}>{s.delivery.captainPhone}</Text>
            </TouchableOpacity>
            <View style={styles.statusBadge} testID="delivery-status">
              <Text style={styles.statusBadgeText}>{DELIVERY_LABEL[s.delivery.status]}</Text>
            </View>

            <View style={styles.actionsCol}>
              {NEXT_DELIVERY_STEPS[s.delivery.status].map((next) => (
                <TouchableOpacity
                  key={next}
                  style={[styles.button, busy && styles.buttonDisabled]}
                  disabled={busy}
                  onPress={() => act(() => api.updateDelivery(s.id, next), `Marked ${DELIVERY_LABEL[next].toLowerCase()}`)}
                  testID={`delivery-to-${next}`}
                >
                  <Text style={styles.buttonText}>Mark {DELIVERY_LABEL[next].toLowerCase()}</Text>
                </TouchableOpacity>
              ))}
              {!["DELIVERED", "FAILED"].includes(s.delivery.status) && !failing && (
                <TouchableOpacity
                  style={styles.dangerButton}
                  disabled={busy}
                  onPress={() => setFailing(true)}
                  testID="delivery-fail"
                >
                  <Text style={styles.dangerButtonText}>Delivery failed</Text>
                </TouchableOpacity>
              )}
            </View>

            {failing && (
              <View testID="fail-box">
                <Text style={styles.label}>
                  What went wrong? This cancels the order and the customer is told why.
                </Text>
                <TextInput
                  style={styles.input}
                  value={failNote}
                  onChangeText={setFailNote}
                  placeholder="e.g. Customer did not answer the door"
                  placeholderTextColor={colors.faint}
                  testID="fail-note"
                />
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={[styles.dangerButton, (busy || failNote.trim().length < 3) && styles.buttonDisabled]}
                    disabled={busy || failNote.trim().length < 3}
                    onPress={async () => {
                      await act(() => api.updateDelivery(s.id, "FAILED", failNote), "Delivery marked failed");
                      setFailing(false);
                      setFailNote("");
                    }}
                    testID="confirm-fail"
                  >
                    <Text style={styles.dangerButtonText}>Mark delivery failed</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.ghostButton}
                    onPress={() => {
                      setFailing(false);
                      setFailNote("");
                    }}
                    testID="abort-fail"
                  >
                    <Text style={styles.ghostButtonText}>Never mind</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}
          <View style={{ height: space.xxl }} />
        </ScrollView>
        <Toast state={toast} onDismiss={() => setToast(null)} />
      </View>
    );
  }

  // ---- List view ----
  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        {error && (
          <View style={styles.errorBox} testID="orders-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.listHead}>
          <Text style={styles.syncText} testID="last-updated">
            {lastSync ? `Updated ${relativeTime(new Date(lastSync).toISOString())}` : "Loading…"}
          </Text>
          <TouchableOpacity onPress={onRefresh} testID="refresh-orders">
            <Text style={styles.refreshLink}>↻ Refresh</Text>
          </TouchableOpacity>
        </View>

        <Chips<OrderFilter>
          testIDPrefix="orderfilter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "new", label: "New", count: counts.new },
            { value: "active", label: "Active", count: counts.active },
            { value: "done", label: "Done", count: counts.done },
          ]}
        />

        {orders.length === 0 ? (
          <Text style={styles.emptyText} testID="no-orders">
            No orders yet.
          </Text>
        ) : visibleOrders.length === 0 ? (
          <Text style={styles.emptyText} testID="no-orders-filtered">
            No {filter} orders right now.
          </Text>
        ) : (
          visibleOrders.map((o) => {
            const waitingMins = o.status === "PENDING" ? minutesSince(o.createdAt) : 0;
            const urgent = waitingMins >= URGENT_MINUTES;
            return (
              <TouchableOpacity
                key={o.id}
                style={[styles.orderRow, urgent && styles.orderRowUrgent]}
                onPress={() => open(o.id)}
                testID="order-row"
              >
                <View style={styles.orderRowTop}>
                  <Text style={styles.orderTime}>{relativeTime(o.createdAt)}</Text>
                  <View
                    style={[styles.statusBadge, o.status === "PENDING" && styles.statusBadgeNew]}
                    testID="order-status"
                  >
                    <Text style={styles.statusBadgeText}>{STATUS_LABEL[o.status]}</Text>
                  </View>
                </View>
                <Text style={styles.orderMeta}>
                  {o.customerPhone ?? "—"} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"} · {o.totalPrice} JOD
                </Text>
                {urgent && (
                  <Text style={styles.waiting} testID="order-waiting">
                    ⏳ Waiting {waitingMins} min — please confirm
                  </Text>
                )}
                {o.unavailableCount > 0 && (
                  <Text style={styles.unavailable} testID="row-unavailable">
                    {o.unavailableCount} out of stock
                  </Text>
                )}
              </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: space.xxl }} />
      </ScrollView>
      <Toast state={toast} onDismiss={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.lg,
    ...shadow.card,
  },
  cardTitle: { ...font.h2, color: colors.ink, marginBottom: space.sm },
  detailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.md },
  backLink: { ...font.bodyStrong, color: colors.brand },
  detailTitle: { ...font.h1, color: colors.ink, marginBottom: space.xs },
  detailSub: { ...font.small, color: colors.muted, marginBottom: space.md },
  statusBadge: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    alignSelf: "flex-start",
  },
  statusBadgeNew: { backgroundColor: colors.accentSoft },
  statusBadgeText: { ...font.tiny, color: colors.inkSoft },
  callButton: {
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  callButtonText: { color: colors.brand, fontWeight: "700", textAlign: "center" },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  itemInfo: { flex: 1, paddingRight: space.md },
  itemName: { ...font.bodyStrong, color: colors.ink },
  itemNameOut: { color: colors.muted, textDecorationLine: "line-through" },
  itemMeta: { ...font.small, color: colors.muted, marginTop: 2 },
  totals: { ...font.small, color: colors.inkSoft, marginTop: space.md },
  pill: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, borderWidth: 1 },
  pillOn: { backgroundColor: colors.okSoft, borderColor: colors.brandBorder },
  pillOff: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  pillOnText: { ...font.tiny, color: colors.ok },
  pillOffText: { ...font.tiny, color: colors.danger },
  actionsCol: { gap: space.sm, marginBottom: space.md },
  actionsRow: { flexDirection: "row", gap: space.md, alignItems: "center", marginTop: space.md },
  button: { backgroundColor: colors.brand, borderRadius: radius.sm, paddingVertical: 14, alignItems: "center" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  dangerButton: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: "center",
    paddingHorizontal: space.md,
  },
  dangerButtonText: { color: colors.danger, fontWeight: "700" },
  ghostButton: { paddingVertical: 14, paddingHorizontal: space.md },
  ghostButtonText: { color: colors.muted, fontWeight: "700" },
  label: { ...font.h3, color: colors.ink, marginTop: space.sm, marginBottom: space.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  muted: { ...font.small, color: colors.muted },
  linkAction: { ...font.bodyStrong, color: colors.brand, marginTop: space.xs },
  emptyText: { ...font.body, color: colors.muted, textAlign: "center", padding: space.xxl },
  listHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: space.md,
  },
  syncText: { ...font.small, color: colors.muted },
  refreshLink: { ...font.bodyStrong, color: colors.brand },
  orderRow: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    ...shadow.card,
  },
  orderRowUrgent: { borderWidth: 1, borderColor: colors.accentBorder },
  orderRowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  orderTime: { ...font.small, color: colors.muted },
  orderMeta: { ...font.body, color: colors.ink, marginTop: space.xs },
  waiting: { ...font.tiny, color: colors.warn, marginTop: space.xs },
  unavailable: { ...font.tiny, color: colors.danger, marginTop: space.xs },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  errorText: { color: colors.danger, fontSize: 13 },
});
