import { useState } from "react";
import { alertSound } from "./alertSound";
import { api, setRole, setToken } from "./api";

/**
 * Phone + OTP sign-in, with shop registration for new merchants.
 *
 * Two steps: request a code, then enter it. In development the API returns the
 * code directly (no SMS provider yet), so it is prefilled to keep testing quick.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [step, setStep] = useState<"phone" | "code">("phone");

  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [shopName, setShopName] = useState("");
  const [openingHours, setOpeningHours] = useState("08:00-23:00");

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.registerMerchant({
        phoneNumber,
        shopName,
        // Fixed to Amman for the pilot; a map picker can come later.
        locationLat: 31.9539,
        locationLng: 35.9106,
        openingHours,
      });
      setNotice("Shop registered. Now sign in with a login code.");
      setMode("login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOtp(phoneNumber);
      if (res.devCode) {
        setCode(res.devCode);
        setNotice(`Development mode: your code is ${res.devCode}`);
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

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(phoneNumber, code);
      setToken(res.accessToken);
      // Decides whether the admin panel or the shop dashboard is shown.
      setRole(res.user.role);

      // Unlock the new-order alarm while we still have a user gesture to do it
      // with. Browsers refuse to play audio until the user has interacted with
      // the page, and this click is the interaction. Without priming here, the
      // first new-order alarm of the session would be silently swallowed by the
      // autoplay policy — no error, no sound, and quite possibly a missed
      // order. Safe for the admin too; they simply never trigger it.
      void alertSound.prime();

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
        <h1 className="brand">
          Half-Dinar <span>Shops</span>
        </h1>
        <p className="muted">Merchant dashboard</p>

        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert notice">{notice}</div>}

        {mode === "register" ? (
          <form onSubmit={handleRegister}>
            <label htmlFor="shopName">Shop name</label>
            <input
              id="shopName"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="Al-Nus Dinar Shop"
              required
            />

            <label htmlFor="regPhone">Phone number</label>
            <input
              id="regPhone"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="0791234567"
              required
            />

            <label htmlFor="hours">Opening hours</label>
            <input
              id="hours"
              value={openingHours}
              onChange={(e) => setOpeningHours(e.target.value)}
              required
            />

            <button type="submit" disabled={busy}>
              {busy ? "Registering..." : "Register shop"}
            </button>
            <button type="button" className="link" onClick={() => setMode("login")}>
              Already registered? Sign in
            </button>
          </form>
        ) : step === "phone" ? (
          <form onSubmit={handleRequestCode}>
            <label htmlFor="phone">Phone number</label>
            <input
              id="phone"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="0791234567"
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? "Sending..." : "Send login code"}
            </button>
            <button type="button" className="link" onClick={() => setMode("register")}>
              New shop? Register here
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify}>
            <label htmlFor="code">6-digit code</label>
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
              {busy ? "Verifying..." : "Sign in"}
            </button>
            <button type="button" className="link" onClick={() => setStep("phone")}>
              Use a different number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
