import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, setRole, setToken } from "./api";
import { LanguageToggle } from "./i18n/LanguageToggle";

/**
 * Admin phone + OTP sign-in.
 *
 * Two steps: request a code, then enter it. In development the API returns the
 * code directly (no SMS provider yet), so it is prefilled to keep testing quick.
 *
 * There is no "register" flow here any more: merchants register in the native
 * merchant app, and admin accounts are provisioned by seeding, not self-signup.
 * A non-admin who signs in is caught by App and shown a clear message.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOtp(phoneNumber);
      if (res.devCode) {
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
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(phoneNumber, code);
      setToken(res.accessToken);
      // Display only — App gates on this, but every request is role-checked
      // server-side regardless.
      setRole(res.user.role);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <div className="auth-toggle">
          <LanguageToggle />
        </div>
        <h1 className="brand">
          {t("brand.name")} <span>{t("brand.accent")}</span>
        </h1>
        <p className="muted">{t("login.adminConsole")}</p>

        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {notice && <div className="alert notice">{notice}</div>}

        {step === "phone" ? (
          <form onSubmit={handleRequestCode}>
            <label htmlFor="phone">{t("login.phoneNumber")}</label>
            <input
              id="phone"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="0799999999"
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? t("login.sending") : t("login.sendCode")}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify}>
            <label htmlFor="code">{t("login.codeLabel")}</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? t("login.verifying") : t("login.signIn")}
            </button>
            <button type="button" className="link" onClick={() => setStep("phone")}>
              {t("login.differentNumber")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
