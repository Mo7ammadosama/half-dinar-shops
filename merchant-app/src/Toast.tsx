/**
 * A lightweight, non-blocking feedback toast.
 *
 * Every merchant action used to complete silently — the list just re-fetched, and
 * a shopkeeper working fast had no confirmation that "Confirm", "Save" or "Out of
 * stock" actually took. This shows a brief message at the bottom of the screen,
 * optionally with a single action (used for "Undo" on the availability toggle —
 * the one safely-reversible action; order state changes notify the customer and
 * are deliberately NOT undoable).
 *
 * It is `pointerEvents="box-none"` so it never blocks taps on the screen beneath
 * it, and it auto-dismisses. The timer is cleared on unmount, so it is safe on the
 * native render smoke test (which mounts and unmounts each screen).
 */
import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, font, radius, shadow, space } from "./theme";

export type ToastState = {
  message: string;
  tone?: "ok" | "info" | "danger";
  actionLabel?: string;
  onAction?: () => void;
} | null;

export function Toast({ state, onDismiss }: { state: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    if (!state) return;
    // Give a little longer when there is an action to tap (e.g. "Undo").
    const t = setTimeout(onDismiss, state.actionLabel ? 5000 : 2800);
    return () => clearTimeout(t);
  }, [state, onDismiss]);

  if (!state) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none" testID="toast">
      <View
        style={[
          styles.toast,
          state.tone === "ok" && styles.toastOk,
          state.tone === "danger" && styles.toastDanger,
        ]}
      >
        <Text style={styles.message} testID="toast-message" numberOfLines={2}>
          {state.message}
        </Text>
        {state.actionLabel && state.onAction && (
          <TouchableOpacity
            onPress={() => {
              state.onAction?.();
              onDismiss();
            }}
            testID="toast-action"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.action}>{state.actionLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    maxWidth: 520,
    width: "100%",
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    ...shadow.bar,
  },
  toastOk: { backgroundColor: colors.brandDark },
  toastDanger: { backgroundColor: colors.danger },
  message: { ...font.small, color: "#fff", flexShrink: 1 },
  action: { ...font.bodyStrong, color: colors.brandBorder },
});
