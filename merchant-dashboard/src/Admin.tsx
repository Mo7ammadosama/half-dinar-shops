/**
 * The admin panel.
 *
 * Approve or suspend shops, manage the master category list, and look across
 * every order in the system. Lives in the same web app as the merchant
 * dashboard and is shown only to an ADMIN account — the API enforces the role
 * regardless of what this component renders.
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AdminCategory,
  type AdminMerchant,
  type AdminOrder,
  type AdminStats,
  type IgnoredOrder,
  type MerchantStatus,
} from "./api";

type Section = "merchants" | "categories" | "orders" | "ignored";

const MERCHANT_STATUS_LABEL: Record<MerchantStatus, string> = {
  PENDING: "Awaiting approval",
  APPROVED: "Approved",
  SUSPENDED: "Suspended",
};

/** "8 minutes" reads faster than "487 seconds" when someone is waiting. */
function formatWaiting(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function Admin() {
  const [section, setSection] = useState<Section>("merchants");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [cancelledOnly, setCancelledOnly] = useState(false);
  const [ignored, setIgnored] = useState<IgnoredOrder[]>([]);

  const [newCategory, setNewCategory] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState("");

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.adminStats());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const load = useCallback(
    async (which: Section) => {
      setError(null);
      try {
        if (which === "merchants") setMerchants(await api.adminMerchants());
        if (which === "categories") setCategories(await api.adminCategories());
        if (which === "orders") setOrders(await api.adminOrders({ cancelledOnly }));
        if (which === "ignored") setIgnored(await api.adminIgnoredOrders());
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [cancelledOnly],
  );

  /**
   * Watch for ignored orders regardless of which section is open.
   *
   * The escalation is only useful if the admin notices without going looking —
   * an alert you must click a tab to discover is not an alert.
   *
   * Polled rather than streamed: unlike the shopkeeper's alarm (which stands
   * between a customer and a forgotten order, and is pushed), this is a
   * supervisory screen. But the interval still matters — a customer is already
   * waiting by the time anything lands here, so adding minutes of discovery
   * latency on top of the escalation window would waste a meaningful slice of
   * it. One request per 20s from a single admin is nothing.
   */
  useEffect(() => {
    const check = async () => {
      try {
        setIgnored(await api.adminIgnoredOrders());
      } catch {
        // A failed background check must not disrupt the admin's work.
      }
    };
    void check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, []);

  // Refresh the headline numbers whenever the view changes, not just at mount.
  // Loading them once left the Overview reading "0 orders" while the table below
  // it listed real ones — the data had arrived after the stats were fetched.
  useEffect(() => {
    void load(section);
    void loadStats();
  }, [section, load, loadStats]);

  /** Runs an action, then refreshes the section and the headline stats. */
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load(section);
      await loadStats();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {stats && (
        <section className="card" data-testid="admin-stats">
          <h2>Overview</h2>
          <p className="muted">
            <strong data-testid="stat-pending">{stats.pendingMerchants}</strong> shop(s) awaiting
            approval · <strong>{stats.approvedMerchants}</strong> approved ·{" "}
            <strong>{stats.totalOrders}</strong> orders ·{" "}
            <strong data-testid="stat-cancelled">{stats.cancelledOrders}</strong> cancelled ·{" "}
            <strong>{stats.deliveredOrders}</strong> delivered
            {stats.averageRating && (
              <>
                {" "}
                · <strong data-testid="stat-rating">{stats.averageRating}★</strong> from{" "}
                {stats.reviewCount} review(s)
              </>
            )}
          </p>
        </section>
      )}

      <nav className="tabs">
        <button
          className={`tab ${section === "merchants" ? "tab-active" : ""}`}
          onClick={() => setSection("merchants")}
          data-testid="admin-tab-merchants"
        >
          Shops
          {stats && stats.pendingMerchants > 0 && (
            <span className="tab-badge">{stats.pendingMerchants}</span>
          )}
        </button>
        <button
          className={`tab ${section === "categories" ? "tab-active" : ""}`}
          onClick={() => setSection("categories")}
          data-testid="admin-tab-categories"
        >
          Categories
        </button>
        <button
          className={`tab ${section === "orders" ? "tab-active" : ""}`}
          onClick={() => setSection("orders")}
          data-testid="admin-tab-orders"
        >
          All orders
        </button>
        {/*
          The escalation queue. The badge is always visible, from any section —
          this is the last line of defence for an order the shop never looked at.
        */}
        <button
          className={`tab ${section === "ignored" ? "tab-active" : ""}`}
          onClick={() => setSection("ignored")}
          data-testid="admin-tab-ignored"
        >
          Not responded to
          {ignored.length > 0 && (
            <span className="tab-badge tab-badge-urgent" data-testid="admin-ignored-badge">
              {ignored.length}
            </span>
          )}
        </button>
      </nav>

      {error && (
        <div className="alert error" role="alert" data-testid="admin-error">
          {error}
        </div>
      )}

      {section === "merchants" && (
        <section className="card">
          <h2>Shops</h2>
          {merchants.length === 0 ? (
            <p className="muted empty">No shops registered yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Shop</th>
                  <th>Phone</th>
                  <th>Products</th>
                  <th>Orders</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.id} data-testid="admin-merchant-row">
                    <td className="name">{m.shopName}</td>
                    <td className="muted">{m.phoneNumber}</td>
                    <td>{m.productCount}</td>
                    <td>{m.orderCount}</td>
                    <td>
                      <span
                        className={`badge ${m.status.toLowerCase()}`}
                        data-testid={`merchant-status-${m.shopName}`}
                      >
                        {MERCHANT_STATUS_LABEL[m.status]}
                      </span>
                    </td>
                    <td className="row-actions">
                      {m.status !== "APPROVED" && (
                        <button
                          disabled={busy}
                          onClick={() => act(() => api.adminSetMerchantStatus(m.id, "APPROVED"))}
                          data-testid={`approve-${m.shopName}`}
                        >
                          Approve
                        </button>
                      )}
                      {m.status !== "SUSPENDED" && (
                        <button
                          className="ghost danger"
                          disabled={busy}
                          onClick={() => act(() => api.adminSetMerchantStatus(m.id, "SUSPENDED"))}
                          data-testid={`suspend-${m.shopName}`}
                        >
                          {m.status === "PENDING" ? "Reject" : "Suspend"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {section === "categories" && (
        <section className="card">
          <h2>Master categories</h2>
          <p className="muted">
            Shared by every shop. Merchants choose from this list but cannot change it.
          </p>

          <div className="product-form">
            <div className="field">
              <label htmlFor="newCategory">New category</label>
              <input
                id="newCategory"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="e.g. Baby Care"
                data-testid="new-category-name"
              />
            </div>
            <div className="field">
              <label htmlFor="newCategoryParent">Inside</label>
              <select
                id="newCategoryParent"
                value={newCategoryParent}
                onChange={(e) => setNewCategoryParent(e.target.value)}
                data-testid="new-category-parent"
              >
                <option value="">Top level</option>
                {categories
                  .filter((c) => c.parentCategoryId === null)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="actions">
              <button
                disabled={busy || newCategory.trim().length < 2}
                onClick={async () => {
                  await act(() =>
                    api.adminCreateCategory(newCategory, newCategoryParent || undefined),
                  );
                  setNewCategory("");
                  setNewCategoryParent("");
                }}
                data-testid="add-category"
              >
                Add category
              </button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Products</th>
                <th>Subcategories</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} data-testid="admin-category-row">
                  <td className="name">{c.path}</td>
                  <td>{c.productCount}</td>
                  <td>{c.subcategoryCount}</td>
                  <td className="row-actions">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        const name = prompt(`Rename "${c.name}" to:`, c.name);
                        if (name) void act(() => api.adminRenameCategory(c.id, name));
                      }}
                      data-testid={`rename-${c.name}`}
                    >
                      Rename
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Delete "${c.path}"?`)) {
                          void act(() => api.adminDeleteCategory(c.id));
                        }
                      }}
                      data-testid={`delete-category-${c.name}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {section === "ignored" && (
        <section className="card">
          <div className="list-head">
            <h2>Orders the shop has not responded to</h2>
          </div>

          {ignored.length === 0 ? (
            <p className="muted empty" data-testid="admin-ignored-empty">
              Nothing waiting. Every order has been picked up by its shop.
            </p>
          ) : (
            <>
              <p className="alert error" role="alert">
                These customers are waiting and the shop has not acknowledged their order. Call the
                shop. The customer can cancel free of charge.
              </p>
              <table data-testid="admin-ignored-table">
                <thead>
                  <tr>
                    <th>Waiting</th>
                    <th>Shop</th>
                    <th>Call the shop</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {ignored.map((o) => (
                    <tr key={o.id} data-testid="admin-ignored-row">
                      <td>
                        <strong data-testid="admin-ignored-waiting">
                          {formatWaiting(o.waitingSeconds)}
                        </strong>
                      </td>
                      <td>{o.shopName}</td>
                      <td>
                        {/* The admin's actual job here is to phone the shop. */}
                        <a href={`tel:${o.shopPhone}`} data-testid="admin-ignored-shop-phone">
                          {o.shopPhone}
                        </a>
                      </td>
                      <td>{o.customerPhone}</td>
                      <td>{o.itemCount}</td>
                      <td>{o.totalPrice} JOD</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {section === "orders" && (
        <section className="card">
          <div className="list-head">
            <h2>All orders</h2>
            <label className="muted">
              <input
                type="checkbox"
                checked={cancelledOnly}
                onChange={(e) => setCancelledOnly(e.target.checked)}
                data-testid="cancelled-only"
                style={{ width: "auto", marginRight: 6 }}
              />
              Cancellations only
            </label>
          </div>

          {orders.length === 0 ? (
            <p className="muted empty" data-testid="admin-no-orders">
              No orders to show.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Placed</th>
                  <th>Shop</th>
                  <th>Customer</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} data-testid="admin-order-row">
                    <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
                    <td>{o.shopName}</td>
                    <td className="muted">{o.customerPhone}</td>
                    <td className="price">{o.totalPrice} JOD</td>
                    <td>
                      <span className={`badge ${o.status.toLowerCase()}`}>{o.status}</span>
                    </td>
                    <td className="muted">
                      {o.cancellationReason && (
                        <span data-testid="admin-order-cancel-reason">
                          {o.cancelledBy?.toLowerCase()}: {o.cancellationReason}
                        </span>
                      )}
                      {o.review && (
                        <span data-testid="admin-order-review">
                          {"★".repeat(o.review.rating)} {o.review.comment ?? ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
