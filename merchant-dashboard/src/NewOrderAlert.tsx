import { useEffect, useState } from "react";
import { alertSound } from "./alertSound";

interface Props {
  /** How many orders are waiting to be confirmed. */
  pendingCount: number;
  /** Highest escalation level among them: 0 fine, 1 overdue, 2 admin notified. */
  escalationLevel?: 0 | 1 | 2;
  /** Stops the alarm and takes the shopkeeper to the order. */
  onAcknowledge: () => void;
  /** True while the live stream is connected (vs falling back to polling). */
  streamConnected: boolean;
}

const ORIGINAL_TITLE = "Half-Dinar Shops";

/**
 * The one thing in this dashboard that must not be missable.
 *
 * If the shop misses an order, the customer waits for something that is never
 * coming and nothing tells them why — the worst failure this product has. So
 * this alerts on four channels at once, because each one alone has a hole:
 *
 *   - **Sound**, repeating until acknowledged — the shopkeeper is serving
 *     someone at the counter, not watching a laptop.
 *   - **Tab title**, alternating — the dashboard is very likely in a background
 *     tab behind whatever else they are doing.
 *   - **A desktop notification** — covers the tab being hidden entirely.
 *   - **A banner that will not dismiss itself** — covers the sound being muted
 *     and the notification permission being refused.
 *
 * It stays until a human clicks it. Nothing here auto-dismisses on a timer: a
 * timeout would silently return the shop to exactly the state this exists to
 * prevent.
 */
export function NewOrderAlert({
  pendingCount,
  escalationLevel = 0,
  onAcknowledge,
  streamConnected,
}: Props) {
  /**
   * How many orders the shopkeeper has already been alerted to and seen.
   *
   * Tracking *acknowledged count* rather than a simple on/off flag is what
   * makes a SECOND order raise the alarm again while the first is still
   * pending. A boolean "dismissed" would leave the busiest moment — orders
   * arriving back to back — as the one moment the dashboard stayed silent.
   */
  const [acknowledged, setAcknowledged] = useState(0);

  // Orders were dealt with: re-arm, so the next one alerts from scratch.
  useEffect(() => {
    if (pendingCount < acknowledged) setAcknowledged(pendingCount);
  }, [pendingCount, acknowledged]);

  const unacknowledged = Math.max(0, pendingCount - acknowledged);
  const active = unacknowledged > 0;

  // Sound. Keyed on the unacknowledged count, so a new arrival re-triggers it.
  useEffect(() => {
    if (active) alertSound.start();
    else alertSound.stop();
    return () => alertSound.stop();
  }, [active, unacknowledged]);

  function acknowledge() {
    setAcknowledged(pendingCount);
    alertSound.stop();
    onAcknowledge();
  }

  // Tab title. Alternates so it is noticeable in a background tab.
  useEffect(() => {
    if (!active) {
      document.title = ORIGINAL_TITLE;
      return;
    }

    const badge = `(${unacknowledged}) NEW ORDER${unacknowledged > 1 ? "S" : ""}`;
    let showBadge = true;
    document.title = badge;

    const t = setInterval(() => {
      showBadge = !showBadge;
      document.title = showBadge ? badge : ORIGINAL_TITLE;
    }, 1_000);

    return () => {
      clearInterval(t);
      document.title = ORIGINAL_TITLE;
    };
  }, [active, unacknowledged]);

  // Desktop notification, for when the tab is not visible at all.
  useEffect(() => {
    if (!active || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return; // The banner is enough.

    const notification = new Notification("New order waiting", {
      body: `${unacknowledged} order${unacknowledged > 1 ? "s" : ""} need${
        unacknowledged > 1 ? "" : "s"
      } confirming.`,
      // Replaces any previous one rather than stacking a wall of them.
      tag: "halfdinar-new-order",
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      acknowledge();
      notification.close();
    };

    return () => notification.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, unacknowledged]);

  if (!active) return null;

  const urgent = escalationLevel >= 1;

  return (
    <div
      className={`order-alert${urgent ? " order-alert-urgent" : ""}`}
      role="alert"
      aria-live="assertive"
      data-testid="new-order-alert"
    >
      <div className="order-alert-body">
        <span className="order-alert-icon" aria-hidden="true">
          {urgent ? "🚨" : "🔔"}
        </span>
        <div>
          <strong data-testid="new-order-alert-title">
            {unacknowledged} new order{unacknowledged > 1 ? "s" : ""} waiting
          </strong>
          <p className="order-alert-note">
            {escalationLevel === 2
              ? "This has been waiting a long time — the admin has been notified."
              : escalationLevel === 1
                ? "Still waiting — please confirm or cancel."
                : "Confirm the order so the customer knows you have it."}
          </p>
        </div>
      </div>

      <button
        type="button"
        className="order-alert-action"
        onClick={acknowledge}
        data-testid="new-order-alert-ack"
      >
        View {unacknowledged > 1 ? "orders" : "order"}
      </button>

      {/*
        Shown only when the live stream is down, so the shopkeeper knows alerts
        may be up to ~10s late rather than wondering why the screen feels slow.
        Not an error: the poll still guarantees the order is seen.
      */}
      {!streamConnected && (
        <span className="order-alert-degraded" data-testid="stream-degraded">
          reconnecting…
        </span>
      )}
    </div>
  );
}
