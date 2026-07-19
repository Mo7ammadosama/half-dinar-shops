/**
 * Merchant phone + OTP sign-in, with new-shop registration.
 *
 * Two audiences, one screen:
 *   - Sign in: request a 6-digit code, enter it. In development the API returns
 *     the code (no SMS provider yet), so it is prefilled to keep testing quick.
 *   - Register: create a shop (PENDING admin approval), then sign in.
 *
 * The verified role is handed up to App, which gates the app to MERCHANT — a
 * customer or admin who signs in here is shown a friendly "wrong app" message
 * rather than a screen full of 403s.
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
import { colors, font, radius, space } from "./theme";

// Fixed to Amman for the pilot, same as the old dashboard. A map picker can come
// later; the shop's real coordinates are set by the admin on approval if needed.
const PILOT_LAT = 31.9539;
const PILOT_LNG = 35.9106;

export function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (result: { token: string; role: string; userId: string }) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [step, setStep] = useState<"phone" | "code">("phone");

  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [shopName, setShopName] = useState("");
  const [openingHours, setOpeningHours] = useState("08:00-23:00");

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRegister() {
    setBusy(true);
    setError(null);
    try {
      await api.registerMerchant({
        phoneNumber,
        shopName,
        locationLat: PILOT_LAT,
        locationLng: PILOT_LNG,
        openingHours,
      });
      setNotice("Shop registered. Now sign in with a login code.");
      setMode("login");
      setStep("phone");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOtp(phoneNumber);
      if (res.devCode) {
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
      onSignedIn({ token: res.accessToken, role: res.user.role, userId: res.user.id });
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
          Half-Dinar <Text style={styles.brandAccent}>Merchant</Text>
        </Text>
        <Text style={styles.tagline}>Run your shop from your phone.</Text>

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

        {mode === "register" ? (
          <View style={styles.card}>
            <Text style={styles.label}>Shop name</Text>
            <TextInput
              style={styles.input}
              value={shopName}
              onChangeText={setShopName}
              placeholder="Al-Nus Dinar Shop"
              placeholderTextColor={colors.faint}
              testID="reg-shop-name"
            />
            <Text style={styles.label}>Phone number</Text>
            <TextInput
              style={styles.input}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholder="07 9123 4567"
              placeholderTextColor={colors.faint}
              keyboardType="phone-pad"
              testID="reg-phone"
            />
            <Text style={styles.label}>Opening hours</Text>
            <TextInput
              style={styles.input}
              value={openingHours}
              onChangeText={setOpeningHours}
              placeholder="08:00-23:00"
              placeholderTextColor={colors.faint}
              testID="reg-hours"
            />
            <TouchableOpacity
              style={[styles.button, (busy || !shopName || !phoneNumber) && styles.buttonDisabled]}
              onPress={handleRegister}
              disabled={busy || !shopName || !phoneNumber}
              testID="register-shop"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Register shop</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setMode("login");
                setError(null);
                setNotice(null);
              }}
              testID="to-login"
            >
              <Text style={styles.link}>Already registered? Sign in</Text>
            </TouchableOpacity>
          </View>
        ) : step === "phone" ? (
          <View style={styles.card}>
            <Text style={styles.label}>Your phone number</Text>
            <TextInput
              style={styles.input}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholder="07 9123 4567"
              placeholderTextColor={colors.faint}
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
            <TouchableOpacity
              onPress={() => {
                setMode("register");
                setError(null);
                setNotice(null);
              }}
              testID="to-register"
            >
              <Text style={styles.link}>New shop? Register here</Text>
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
              placeholderTextColor={colors.faint}
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
  brand: { ...font.display, color: colors.ink, textAlign: "center" },
  brandAccent: { color: colors.brand },
  tagline: {
    ...font.small,
    color: colors.muted,
    textAlign: "center",
    marginTop: space.xs,
    marginBottom: space.xxl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.xl,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: { ...font.h3, color: colors.ink, marginBottom: space.sm, marginTop: space.md },
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
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: "center" },
  hint: { ...font.small, color: colors.muted, marginTop: space.sm },
  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: space.lg,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  link: { color: colors.brand, textAlign: "center", marginTop: space.lg, fontWeight: "600" },
  alert: { borderRadius: radius.sm, padding: space.md, marginBottom: space.md, borderWidth: 1 },
  alertError: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  alertErrorText: { color: colors.danger, fontSize: 13 },
  alertNotice: { backgroundColor: colors.brandSoft, borderColor: colors.brandBorder },
  alertNoticeText: { color: colors.ok, fontSize: 13 },
});
