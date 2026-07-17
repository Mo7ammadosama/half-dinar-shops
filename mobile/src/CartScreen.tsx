/**
 * Cart and checkout.
 *
 * Shows the running total, the delivery fee fetched from the server, and places
 * the order. Payment is cash on delivery, so "placing" an order takes no money —
 * it just tells the shop to start picking the items.
 *
 * Only ids and quantities are sent to the server; prices shown here are for
 * display and are re-read from the database server-side.
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { api, type Order } from "./api";
import { cartItemsTotal, multiplyMoney, type CartLine } from "./cart";
import { colors } from "./theme";

/** Adds two fixed-2 money strings without floats. */
function addMoney(a: string, b: string): string {
  const cents = Math.round(parseFloat(a) * 100) + Math.round(parseFloat(b) * 100);
  return (cents / 100).toFixed(2);
}

export function CartScreen({
  visible,
  lines,
  shopId,
  shopName,
  onClose,
  onAdd,
  onRemove,
  onOrderPlaced,
}: {
  visible: boolean;
  lines: CartLine[];
  shopId: string | null;
  shopName: string;
  onClose: () => void;
  onAdd: (productId: string) => void;
  onRemove: (productId: string) => void;
  onOrderPlaced: (order: Order) => void;
}) {
  const [deliveryFee, setDeliveryFee] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the fee from the server rather than hardcoding it, so the total shown
  // always matches what will actually be charged.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    void (async () => {
      try {
        setDeliveryFee((await api.quote()).deliveryFee);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [visible]);

  const itemsTotal = cartItemsTotal(lines);
  const total = deliveryFee ? addMoney(itemsTotal, deliveryFee) : null;

  async function handlePlaceOrder() {
    if (!shopId) return;
    setPlacing(true);
    setError(null);
    try {
      const order = await api.placeOrder(
        shopId,
        lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      );
      onOrderPlaced(order);
    } catch (err) {
      // e.g. an item went out of stock between browsing and checkout.
      setError((err as Error).message);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.flex}>
        <View style={styles.header}>
          <Text style={styles.title}>Your basket</Text>
          <TouchableOpacity onPress={onClose} testID="cart-close">
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        </View>

        {error && (
          <View style={styles.errorBanner} testID="cart-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {lines.length === 0 ? (
          <View style={styles.centered} testID="cart-empty">
            <Text style={styles.emptyTitle}>Your basket is empty</Text>
            <Text style={styles.emptyBody}>Add some items from the shop.</Text>
          </View>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.list}>
              {lines.map((line) => (
                <View key={line.productId} style={styles.line} testID="cart-line">
                  <View style={styles.lineBody}>
                    <Text style={styles.lineName} testID="cart-line-name">
                      {line.name}
                    </Text>
                    <Text style={styles.lineUnit}>{line.displayPrice} JOD each</Text>
                  </View>

                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={styles.stepButton}
                      onPress={() => onRemove(line.productId)}
                      testID={`cart-minus-${line.name}`}
                    >
                      <Text style={styles.stepText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.qty} testID={`cart-qty-${line.name}`}>
                      {line.quantity}
                    </Text>
                    <TouchableOpacity
                      style={styles.stepButton}
                      onPress={() => onAdd(line.productId)}
                      testID={`cart-plus-${line.name}`}
                    >
                      <Text style={styles.stepText}>+</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.lineTotal} testID={`cart-line-total-${line.name}`}>
                    {multiplyMoney(line.displayPrice, line.quantity)} JOD
                  </Text>
                </View>
              ))}
            </ScrollView>

            <View style={styles.summary}>
              <Text style={styles.summaryShop}>Delivered from {shopName}</Text>

              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Items</Text>
                <Text style={styles.summaryValue} testID="summary-items">
                  {itemsTotal} JOD
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Delivery</Text>
                <Text style={styles.summaryValue} testID="summary-delivery">
                  {deliveryFee ? `${deliveryFee} JOD` : "…"}
                </Text>
              </View>
              <View style={[styles.summaryRow, styles.summaryTotalRow]}>
                <Text style={styles.summaryTotalLabel}>Total to pay</Text>
                <Text style={styles.summaryTotalValue} testID="summary-total">
                  {total ? `${total} JOD` : "…"}
                </Text>
              </View>

              <Text style={styles.cod} testID="payment-method">
                Pay with cash on delivery
              </Text>

              <TouchableOpacity
                style={[styles.confirm, (placing || !total) && styles.confirmDisabled]}
                onPress={handlePlaceOrder}
                disabled={placing || !total}
                testID="place-order"
              >
                {placing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.confirmText}>Place order</Text>
                )}
              </TouchableOpacity>
            </View>
          </>
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

  errorBanner: { backgroundColor: "#fef2f2", padding: 12, borderBottomWidth: 1, borderBottomColor: "#fecaca" },
  errorText: { color: colors.danger, fontSize: 13 },

  list: { padding: 12 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  lineBody: { flex: 1 },
  lineName: { fontSize: 15, fontWeight: "700", color: colors.ink },
  lineUnit: { fontSize: 12, color: colors.muted, marginTop: 2 },
  stepper: { flexDirection: "row", alignItems: "center", marginHorizontal: 8 },
  stepButton: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  stepText: { fontSize: 18, fontWeight: "700", color: colors.ink, lineHeight: 20 },
  qty: { width: 30, textAlign: "center", fontSize: 15, fontWeight: "700", color: colors.ink },
  lineTotal: { fontSize: 14, fontWeight: "800", color: colors.brand, minWidth: 66, textAlign: "right" },

  summary: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    padding: 16,
    paddingBottom: 28,
  },
  summaryShop: { fontSize: 12, color: colors.muted, marginBottom: 8 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  summaryLabel: { fontSize: 14, color: colors.muted },
  summaryValue: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  summaryTotalRow: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 8 },
  summaryTotalLabel: { fontSize: 15, fontWeight: "800", color: colors.ink },
  summaryTotalValue: { fontSize: 15, fontWeight: "800", color: colors.brand },
  cod: { fontSize: 12, color: colors.muted, marginTop: 8, marginBottom: 4 },
  confirm: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  confirmDisabled: { opacity: 0.5 },
  confirmText: { color: "#fff", fontWeight: "800", fontSize: 16 },

  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  emptyBody: { fontSize: 13, color: colors.muted, marginTop: 4 },
});
