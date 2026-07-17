/**
 * Catches render/startup crashes and shows the actual error on screen.
 *
 * Without this, a crash gives Expo Go's generic "Something went wrong" screen,
 * which tells neither the customer nor us what actually failed. Here the real
 * message is shown, with a retry — far more useful in the field, and essential
 * for diagnosing a device we cannot see.
 */
import { Component, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "./theme";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Also surfaces in the Metro terminal, so a connected developer sees it too.
    console.error("App crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something broke</Text>
        <Text style={styles.subtitle}>
          The app hit an error. This message is here so it can be fixed.
        </Text>
        <ScrollView style={styles.box} contentContainerStyle={styles.boxContent}>
          <Text style={styles.message} testID="crash-message">
            {error.message}
          </Text>
          {error.stack ? <Text style={styles.stack}>{error.stack}</Text> : null}
        </ScrollView>
        <TouchableOpacity style={styles.button} onPress={() => this.setState({ error: null })}>
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 72 },
  title: { fontSize: 22, fontWeight: "800", color: colors.danger },
  subtitle: { fontSize: 14, color: colors.muted, marginTop: 6, marginBottom: 16 },
  box: {
    flexGrow: 0,
    maxHeight: 360,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
  },
  boxContent: { padding: 12 },
  message: { fontSize: 14, fontWeight: "700", color: colors.ink },
  stack: { fontSize: 11, color: colors.muted, marginTop: 10, fontFamily: "monospace" },
  button: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
  },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 16 },
});
