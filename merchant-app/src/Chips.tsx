/**
 * A horizontal row of selectable "pill" chips — used for the order status filter
 * and the product availability filter. One chip is active at a time. Each chip can
 * carry a small count badge (e.g. how many orders are New), so the shopkeeper sees
 * where the work is without opening anything.
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { colors, font, radius, space } from "./theme";

export type ChipOption<T extends string> = { value: T; label: string; count?: number };

export function Chips<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testIDPrefix: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onChange(opt.value)}
            testID={`${testIDPrefix}-${opt.value}`}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {opt.label}
              {opt.count !== undefined && opt.count > 0 ? `  ${opt.count}` : ""}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, marginBottom: space.md },
  row: { gap: space.sm, paddingRight: space.lg },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { ...font.small, color: colors.inkSoft },
  chipTextActive: { color: "#fff", fontWeight: "700" },
});
