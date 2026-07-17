import { useState } from "react";
import { Admin } from "./Admin";
import { clearToken, getRole, getToken } from "./api";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import "./App.css";

/**
 * One web app, two audiences: shopkeepers and admins.
 *
 * The role decides which screen is shown, but the API enforces roles on every
 * request — this is presentation, not security.
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

  if (role === "ADMIN") {
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

  return <Dashboard />;
}
