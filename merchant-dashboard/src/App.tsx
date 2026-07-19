import { useState } from "react";
import { Admin } from "./Admin";
import { clearToken, getRole, getToken } from "./api";
import { Login } from "./Login";
import "./App.css";

/**
 * The ADMIN web console.
 *
 * This app used to host both the merchant dashboard and the admin panel, with
 * the signed-in role deciding which was shown. Merchants have since moved to
 * their own native app (merchant-app/), so this web app is admin-only.
 *
 * Because there is now exactly ONE role that belongs here, the old
 * "two-audiences-one-localStorage-token" ambiguity is gone: a single browser
 * holds a single admin session. A signed-in user who is NOT an admin is shown a
 * clear message and a way out — never the (now-deleted) merchant screens, and
 * never a screenful of 403s from calling admin endpoints they cannot use.
 */
export default function App() {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [role, setRoleState] = useState(() => getRole());

  function handleSignedIn() {
    setRoleState(getRole());
    setSignedIn(true);
  }

  function signOut() {
    clearToken();
    window.location.reload();
  }

  if (!signedIn) return <Login onSignedIn={handleSignedIn} />;

  // Signed in, but not as an admin. The role here comes from the verify
  // response; it is display only — the API enforces the role on every request —
  // but gating on it means we never fire an admin request we know will 403,
  // which is what used to fill the screen with errors.
  if (role !== "ADMIN") {
    return (
      <div className="auth-shell">
        <div className="card auth-card">
          <h1 className="brand">
            Half-Dinar <span>Shops</span>
          </h1>
          <p className="muted">Admin console</p>
          <div className="alert error" role="alert" data-testid="not-admin">
            This console is for administrators only. If you run a shop, use the Half-Dinar
            Merchant app on your phone.
          </div>
          <button className="ghost" onClick={signOut} data-testid="not-admin-sign-out">
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            Half-Dinar <span>Shops</span>
          </h1>
          <p className="muted" data-testid="admin-header">
            Admin panel
          </p>
        </div>
        <button className="ghost" onClick={signOut} data-testid="admin-sign-out">
          Sign out
        </button>
      </header>
      <Admin />
    </div>
  );
}
