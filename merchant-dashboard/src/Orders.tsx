/**
 * Merchant order handling.
 *
 * The shopkeeper's working screen: see new orders, tick items off as they pick
 * them (or mark them out of stock), confirm, and cancel with a reason.
 *
 * The list polls so a new order appears without the shopkeeper refreshing —
 * there is no push channel yet (launch blocker B6).
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type DeliveryStatus,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
} from "./api";

/** How often to re-check for new orders. */
const POLL_MS = 10_000;

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "New — needs confirming",
  CONFIRMED: "Confirmed",
  PREPARING: "Picking items",
  DELIVERING: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  ASSIGNED: "Driver assigned",
  PICKED_UP: "Driver collected it",
  ON_WAY: "On the way",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
};

/** The next step a human can take from each delivery status. */
const NEXT_DELIVERY_STEPS: Record<DeliveryStatus, DeliveryStatus[]> = {
  ASSIGNED: ["PICKED_UP"],
  PICKED_UP: ["ON_WAY", "DELIVERED"],
  ON_WAY: ["DELIVERED"],
  DELIVERED: [],
  FAILED: [],
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function Orders() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [filter, setFilter] = useState<OrderStatus | "ALL">("ALL");
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const [captainName, setCaptainName] = useState("");
  const [captainPhone, setCaptainPhone] = useState("");
  const [failing, setFailing] = useState(false);
  const [failNote, setFailNote] = useState("");

  const load = useCallback(async (status: OrderStatus | "ALL") => {
    try {
      setOrders(await api.listOrders(status === "ALL" ? undefined : status));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Poll for new orders while the screen is open.
  useEffect(() => {
    const t = setInterval(() => void load(filter), POLL_MS);
    return () => clearInterval(t);
  }, [filter, load]);

  async function open(id: string) {
    setError(null);
    try {
      setSelected(await api.getOrder(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Runs an action, refreshes the detail and the list, and surfaces errors. */
  async function act(fn: () => Promise<OrderDetail>) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await fn());
      await load(filter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!selected) return;
    await act(() => api.cancelOrder(selected.id, cancelReason));
    setCancelling(false);
    setCancelReason("");
  }

  return (
    <div className="card">
      <div className="list-head">
        <h2>Orders</h2>
        <select
          className="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value as OrderStatus | "ALL")}
          aria-label="Filter orders by status"
        >
          <option value="ALL">All orders</option>
          <option value="PENDING">New</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="PREPARING">Picking</option>
          <option value="DELIVERING">Out for delivery</option>
          <option value="DELIVERED">Delivered</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </div>

      {error && (
        <div className="alert error" role="alert" data-testid="orders-error">
          {error}
        </div>
      )}

      {orders.length === 0 ? (
        <p className="muted empty" data-testid="no-orders">
          No orders yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Placed</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} data-testid="order-row">
                <td className="muted">{formatTime(o.createdAt)}</td>
                {/*
                  Null outside the shop's contact window — the server withholds
                  it, it is not merely hidden here. Orders stay identifiable by
                  their time, item count and total.
                */}
                <td>{o.customerPhone ?? <span className="muted">—</span>}</td>
                <td>
                  {o.itemCount}
                  {o.unavailableCount > 0 && (
                    <span className="badge suspended" data-testid="row-unavailable">
                      {o.unavailableCount} out of stock
                    </span>
                  )}
                </td>
                <td className="price">{o.totalPrice} JOD</td>
                <td>
                  <span className={`badge ${o.status.toLowerCase()}`} data-testid="order-status">
                    {STATUS_LABEL[o.status]}
                  </span>
                </td>
                <td className="row-actions">
                  <button className="ghost" onClick={() => open(o.id)} data-testid={`open-${o.id}`}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="drawer" data-testid="order-detail">
          <div className="list-head">
            <h2>
              {/*
                The number is withheld by the server outside the contact window,
                so the heading falls back to the order's own id.
              */}
              Order {selected.customer.phoneNumber ?? `#${selected.id.slice(0, 8)}`}{" "}
              <span className={`badge ${selected.status.toLowerCase()}`} data-testid="detail-status">
                {STATUS_LABEL[selected.status]}
              </span>
            </h2>
            <button className="ghost" onClick={() => setSelected(null)} data-testid="close-detail">
              Close
            </button>
          </div>

          {selected.cancellationReason && (
            <div className="alert error" data-testid="detail-cancel-reason">
              Cancelled by {selected.cancelledBy?.toLowerCase()}: {selected.cancellationReason}
            </div>
          )}

          {/*
            Call the customer — shown while the shop is actually working on the
            order (e.g. to ask about a substitute). Not shown once it is done or
            cancelled, when there is nothing to discuss.
          */}
          {["CONFIRMED", "PREPARING"].includes(selected.status) && (
            <p>
              <a
                className="call-link"
                href={`tel:${selected.customer.phoneNumber}`}
                data-testid="call-customer"
              >
                Call the customer · {selected.customer.phoneNumber}
              </a>
            </p>
          )}

          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Line</th>
                <th>In stock?</th>
              </tr>
            </thead>
            <tbody>
              {selected.items.map((item) => (
                <tr key={item.id} data-testid="detail-item">
                  <td className="name">{item.name}</td>
                  <td>{item.quantity}</td>
                  <td className="price">{item.priceAtOrder} JOD</td>
                  <td className="price">{item.lineTotal} JOD</td>
                  <td>
                    <button
                      className={`toggle ${item.status === "CONFIRMED" ? "on" : "off"}`}
                      disabled={busy || !["PENDING", "CONFIRMED", "PREPARING"].includes(selected.status)}
                      onClick={() =>
                        act(() =>
                          api.setItemStatus(
                            selected.id,
                            item.id,
                            item.status === "CONFIRMED" ? "UNAVAILABLE" : "CONFIRMED",
                          ),
                        )
                      }
                      data-testid={`item-toggle-${item.name}`}
                    >
                      {item.status === "CONFIRMED" ? "Got it" : "Out of stock"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="muted" data-testid="detail-totals">
            Delivery {selected.deliveryFee} JOD · Total {selected.totalPrice} JOD
            {selected.hasUnavailableItems && (
              <>
                {" "}
                · <strong data-testid="detail-revised">Revised {selected.revisedTotal} JOD</strong>{" "}
                once the customer accepts the removals
              </>
            )}
          </p>

          <div className="actions">
            {selected.status === "PENDING" && (
              <button
                disabled={busy}
                onClick={() => act(() => api.confirmOrder(selected.id))}
                data-testid="confirm-order"
              >
                Confirm order
              </button>
            )}
            {selected.status === "CONFIRMED" && (
              <button
                disabled={busy}
                onClick={() => act(() => api.startPreparing(selected.id))}
                data-testid="start-preparing"
              >
                Start picking
              </button>
            )}
            {["CONFIRMED", "PREPARING"].includes(selected.status) && !cancelling && (
              <button
                className="ghost danger"
                disabled={busy}
                onClick={() => setCancelling(true)}
                data-testid="cancel-order"
              >
                Cancel order
              </button>
            )}
          </div>

          {/* Delivery — entered by hand; there is no captain app yet. */}
          {selected.canAssignDelivery && (
            <div className="delivery-box" data-testid="assign-delivery-box">
              <h2>Send it out</h2>
              <p className="muted">
                Type in who is taking it. The customer sees their name and number.
              </p>
              <label htmlFor="captainName">Driver's name</label>
              <input
                id="captainName"
                value={captainName}
                onChange={(e) => setCaptainName(e.target.value)}
                placeholder="Omar Al-Zoubi"
                data-testid="captain-name"
              />
              <label htmlFor="captainPhone">Driver's phone</label>
              <input
                id="captainPhone"
                value={captainPhone}
                onChange={(e) => setCaptainPhone(e.target.value)}
                placeholder="0791122334"
                data-testid="captain-phone"
              />
              <div className="actions">
                <button
                  disabled={busy || captainName.trim().length < 2 || captainPhone.trim().length < 9}
                  onClick={async () => {
                    await act(() => api.assignDelivery(selected.id, captainName, captainPhone));
                    setCaptainName("");
                    setCaptainPhone("");
                  }}
                  data-testid="assign-delivery"
                >
                  Assign driver
                </button>
              </div>
            </div>
          )}

          {selected.delivery && (
            <div className="delivery-box" data-testid="delivery-box">
              <h2>Delivery</h2>
              <p data-testid="delivery-captain">
                <strong>{selected.delivery.captainName}</strong> ·{" "}
                <a href={`tel:${selected.delivery.captainPhone}`} data-testid="delivery-captain-phone">
                  {selected.delivery.captainPhone}
                </a>{" "}
                ·{" "}
                <span className="badge" data-testid="delivery-status">
                  {DELIVERY_LABEL[selected.delivery.status]}
                </span>
              </p>

              <div className="actions">
                {NEXT_DELIVERY_STEPS[selected.delivery.status].map((next) => (
                  <button
                    key={next}
                    disabled={busy}
                    onClick={() => act(() => api.updateDelivery(selected.id, next))}
                    data-testid={`delivery-to-${next}`}
                  >
                    Mark {DELIVERY_LABEL[next].toLowerCase()}
                  </button>
                ))}

                {!["DELIVERED", "FAILED"].includes(selected.delivery.status) && !failing && (
                  <button
                    className="ghost danger"
                    disabled={busy}
                    onClick={() => setFailing(true)}
                    data-testid="delivery-fail"
                  >
                    Delivery failed
                  </button>
                )}
              </div>

              {failing && (
                <div className="cancel-box" data-testid="fail-box">
                  <label htmlFor="failNote">
                    What went wrong? This cancels the order and the customer is told why.
                  </label>
                  <input
                    id="failNote"
                    value={failNote}
                    onChange={(e) => setFailNote(e.target.value)}
                    placeholder="e.g. Customer did not answer the door"
                    data-testid="fail-note"
                  />
                  <div className="actions">
                    <button
                      className="ghost danger"
                      disabled={busy || failNote.trim().length < 3}
                      onClick={async () => {
                        await act(() => api.updateDelivery(selected.id, "FAILED", failNote));
                        setFailing(false);
                        setFailNote("");
                      }}
                      data-testid="confirm-fail"
                    >
                      Mark delivery failed
                    </button>
                    <button
                      className="ghost"
                      onClick={() => {
                        setFailing(false);
                        setFailNote("");
                      }}
                      data-testid="abort-fail"
                    >
                      Never mind
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {cancelling && (
            <div className="cancel-box" data-testid="cancel-box">
              <label htmlFor="cancelReason">
                Why are you cancelling? The customer will see this.
              </label>
              <input
                id="cancelReason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. We are closing early today"
                data-testid="cancel-reason"
              />
              <div className="actions">
                <button
                  className="ghost danger"
                  disabled={busy || cancelReason.trim().length < 3}
                  onClick={handleCancel}
                  data-testid="confirm-cancel"
                >
                  Cancel this order
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    setCancelling(false);
                    setCancelReason("");
                  }}
                  data-testid="abort-cancel"
                >
                  Keep the order
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
