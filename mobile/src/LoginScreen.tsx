/**
 * Phone + OTP sign-in.
 *
 * Two steps: enter phone, then enter the 6-digit code. There is no separate
 * "register" flow — a first-time phone number becomes a customer account, which
 * is how the API is designed.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api } from "./api";
import { colors } from "./theme";

export function LoginScreen({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequestCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOtp(phoneNumber);
      if (res.devCode) {
        // No SMS provider yet: the API returns the code outside production.
        setCode(res.devCode);
        setNotice(`Development mode — your code is ${res.devCode}`);
      } else {
        setNotice("We sent a code to your phone.");
      }
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(phoneNumber, code);
      onSignedIn(res.accessToken);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>
          Half-Dinar <Text style={styles.brandAccent}>Shops</Text>
        </Text>
        <Text style={styles.tagline}>Everything you need, around the corner.</Text>

        {error && (
          <View style={[styles.alert, styles.alertError]} testID="login-error">
            <Text style={styles.alertErrorText}>{error}</Text>
          </View>
        )}
        {notice && !error && (
          <View style={[styles.alert, styles.alertNotice]}>
            <Text style={styles.alertNoticeText}>{notice}</Text>
          </View>
        )}

        {step === "phone" ? (
          <View style={styles.card}>
            <Text style={styles.label}>Your phone number</Text>
            <TextInput
              style={styles.input}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholder="07 9123 4567"
              placeholderTextColor={colors.muted}
              keyboardType="phone-pad"
              autoComplete="tel"
              testID="phone-input"
            />
            <Text style={styles.hint}>We'll text you a code to sign in.</Text>

            <TouchableOpacity
              style={[styles.button, (busy || !phoneNumber) && styles.buttonDisabled]}
              onPress={handleRequestCode}
              disabled={busy || !phoneNumber}
              testID="send-code"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Send code</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>Enter the 6-digit code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              maxLength={6}
              autoComplete="sms-otp"
              testID="code-input"
            />
            <Text style={styles.hint}>Sent to {phoneNumber}</Text>

            <TouchableOpacity
              style={[styles.button, (busy || code.length !== 6) && styles.buttonDisabled]}
              onPress={handleVerify}
              disabled={busy || code.length !== 6}
              testID="verify-code"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                setStep("phone");
                setCode("");
                setNotice(null);
                setError(null);
              }}
              testID="change-number"
            >
              <Text style={styles.link}>Use a different number</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 24 },
  brand: { fontSize: 28, fontWeight: "800", color: colors.ink, textAlign: "center" },
  brandAccent: { color: colors.brand },
  tagline: {
    fontSize: 14,
    color: colors.muted,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 24,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: { fontSize: 14, fontWeight: "600", color: colors.ink, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: "center" },
  hint: { fontSize: 12, color: colors.muted, marginTop: 8 },
  button: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  link: { color: colors.brand, textAlign: "center", marginTop: 14, fontWeight: "600" },
  alert: { borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1 },
  alertError: { backgroundColor: "#fef2f2", borderColor: "#fecaca" },
  alertErrorText: { color: colors.danger, fontSize: 13 },
  alertNotice: { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0" },
  alertNoticeText: { color: colors.ok, fontSize: 13 },
});
