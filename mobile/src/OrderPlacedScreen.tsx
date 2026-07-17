/**
 * Shown right after an order is placed.
 *
 * Repeats back exactly what the shop received — the snapshotted prices and the
 * total the customer will hand over in cash — so there is no ambiguity about
 * what was ordered or what it costs.
 */
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { Order } from "./api";
import { colors } from "./theme";

export function OrderPlacedScreen({
  order,
  onDone,
}: {
  order: Order | null;
  onDone: () => void;
}) {
  if (!order) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={onDone}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✓</Text>
        </View>

        <Text style={styles.title} testID="order-placed-title">
          Order placed
        </Text>
        <Text style={styles.subtitle}>
          {order.shop.shopName} is picking your items now. Pay cash when it arrives.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>What you ordered</Text>
          {order.items.map((item) => (
            <View key={item.id} style={styles.row} testID="placed-item">
              <Text style={styles.rowName}>
                {item.quantity} × {item.name}
              </Text>
              <Text style={styles.rowValue}>{item.lineTotal} JOD</Text>
            </View>
          ))}

          <View style={[styles.row, styles.divider]}>
            <Text style={styles.rowLabel}>Items</Text>
            <Text style={styles.rowValue} testID="placed-items-total">
              {order.itemsTotal} JOD
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Delivery</Text>
            <Text style={styles.rowValue} testID="placed-delivery">
              {order.deliveryFee} JOD
            </Text>
          </View>
          <View style={[styles.row, styles.divider]}>
            <Text style={styles.totalLabel}>Total (cash)</Text>
            <Text style={styles.totalValue} testID="placed-total">
              {order.totalPrice} JOD
            </Text>
          </View>
        </View>

        <Text style={styles.status} testID="placed-status">
          Status: {order.status === "PENDING" ? "Waiting for the shop to confirm" : order.status}
        </Text>

        <TouchableOpacity style={styles.button} onPress={onDone} testID="order-done">
          <Text style={styles.buttonText}>Back to the shop</Text>
        </TouchableOpacity>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: 24, backgroundColor: colors.bg },
  badge: {
    alignSelf: "center",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: "#a7f3d0",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 26, color: colors.ok, fontWeight: "800" },
  title: { fontSize: 22, fontWeight: "800", color: colors.ink, textAlign: "center", marginTop: 12 },
  subtitle: { fontSize: 14, color: colors.muted, textAlign: "center", marginTop: 6, marginBottom: 18 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "800", color: colors.muted, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 8 },
  rowName: { fontSize: 14, color: colors.ink, flex: 1 },
  rowLabel: { fontSize: 14, color: colors.muted },
  rowValue: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  totalLabel: { fontSize: 15, fontWeight: "800", color: colors.ink },
  totalValue: { fontSize: 15, fontWeight: "800", color: colors.brand },
  status: { fontSize: 13, color: colors.muted, textAlign: "center", marginTop: 14 },
  button: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
  },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 16 },
});
