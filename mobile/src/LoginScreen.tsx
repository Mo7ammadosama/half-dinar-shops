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
import { useTranslation } from "react-i18next";
import { api, withConnectRetry, type SessionInvalidReason } from "./api";
import { LanguageToggle } from "./i18n/LanguageToggle";
import { colors } from "./theme";

export function LoginScreen({
  onSignedIn,
  notice: noticeReason = null,
}: {
  onSignedIn: (token: string) => void;
  /** Why we're back here: a saved session that expired, or a shop/admin token. */
  notice?: SessionInvalidReason | null;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  // "expired" is informational (green notice); "wrongRole" is a problem with the
  // account they used, so it reads as an error (red), matching the sign-in path.
  const [notice, setNotice] = useState<string | null>(
    noticeReason === "expired" ? t("login.sessionEnded") : null,
  );
  const [error, setError] = useState<string | null>(
    noticeReason === "wrongRole" ? t("login.wrongRole") : null,
  );
  const [busy, setBusy] = useState(false);
  // True while auto-retrying a connection that failed, so the button can say
  // "Connecting…" instead of appearing to hang. A briefly-unreachable backend
  // (e.g. just started) then self-heals without the customer doing anything.
  const [connecting, setConnecting] = useState(false);

  async function handleRequestCode() {
    setBusy(true);
    setError(null);
    setConnecting(false);
    try {
      // Retry ONLY connection failures (status 0). The request never reached the
      // server, so re-sending cannot duplicate anything.
      const res = await withConnectRetry(() => api.requestOtp(phoneNumber), {
        onRetry: () => setConnecting(true),
      });
      if (res.devCode) {
        // No SMS provider yet: the API returns the code outside production.
        setCode(res.devCode);
        setNotice(t("login.devCode", { code: res.devCode }));
      } else {
        setNotice(t("login.codeSent"));
      }
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConnecting(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(phoneNumber, code);
      // This is the CUSTOMER app: a shop/admin number is a valid login but the
      // wrong account here. Refuse it up front with a clear message instead of
      // signing them in and letting checkout fail with "requires the CUSTOMER role".
      if (res.user.role !== "CUSTOMER") {
        setNotice(null);
        setError(t("login.wrongRole"));
        setStep("phone");
        setCode("");
        return;
      }
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
        <View style={styles.toggleRow}>
          <LanguageToggle />
        </View>
        <Text style={styles.brand}>
          {t("login.brand")} <Text style={styles.brandAccent}>{t("login.brandAccent")}</Text>
        </Text>
        <Text style={styles.tagline}>{t("login.tagline")}</Text>

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
            <Text style={styles.label}>{t("login.yourPhone")}</Text>
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
            <Text style={styles.hint}>{t("login.textHint")}</Text>

            <TouchableOpacity
              style={[styles.button, (busy || !phoneNumber) && styles.buttonDisabled]}
              onPress={handleRequestCode}
              disabled={busy || !phoneNumber}
              testID="send-code"
            >
              {busy ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator color="#fff" />
                  {connecting && <Text style={styles.busyText}>{t("login.connecting")}</Text>}
                </View>
              ) : (
                <Text style={styles.buttonText}>{t("login.sendCode")}</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>{t("login.enterCode")}</Text>
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
            <Text style={styles.hint}>{t("login.sentTo", { phone: phoneNumber })}</Text>

            <TouchableOpacity
              style={[styles.button, (busy || code.length !== 6) && styles.buttonDisabled]}
              onPress={handleVerify}
              disabled={busy || code.length !== 6}
              testID="verify-code"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>{t("login.signIn")}</Text>
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
              <Text style={styles.link}>{t("login.differentNumber")}</Text>
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
  toggleRow: { alignItems: "center", marginBottom: 20 },
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
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  busyText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  link: { color: colors.brand, textAlign: "center", marginTop: 14, fontWeight: "600" },
  alert: { borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1 },
  alertError: { backgroundColor: "#fef2f2", borderColor: "#fecaca" },
  alertErrorText: { color: colors.danger, fontSize: 13 },
  alertNotice: { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0" },
  alertNoticeText: { color: colors.ok, fontSize: 13 },
});
