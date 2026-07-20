/**
 * The admin panel.
 *
 * Approve or suspend shops, manage the master category list, and look across
 * every order in the system. Lives in the same web app as the merchant
 * dashboard and is shown only to an ADMIN account — the API enforces the role
 * regardless of what this component renders.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type AdminCategory,
  type AdminMerchant,
  type AdminOrder,
  type AdminStats,
  type IgnoredOrder,
} from "./api";

type Section = "merchants" | "categories" | "orders" | "ignored";

export function Admin() {
  const { t } = useTranslation();

  /** "8 minutes" reads faster than "487 seconds" when someone is waiting. */
  function formatWaiting(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t("admin.waitingMin", { count: minutes });
    const hours = Math.floor(minutes / 60);
    return t("admin.waitingHm", { h: hours, m: minutes % 60 });
  }

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
          <h2>{t("admin.overview")}</h2>
          <p className="muted">
            <strong data-testid="stat-pending">{stats.pendingMerchants}</strong>{" "}
            {t("admin.statsAwaiting")} · <strong>{stats.approvedMerchants}</strong>{" "}
            {t("admin.statsApproved")} · <strong>{stats.totalOrders}</strong> {t("admin.statsOrders")}{" "}
            · <strong data-testid="stat-cancelled">{stats.cancelledOrders}</strong>{" "}
            {t("admin.statsCancelled")} · <strong>{stats.deliveredOrders}</strong>{" "}
            {t("admin.statsDelivered")}
            {stats.averageRating && (
              <>
                {" "}
                · <strong data-testid="stat-rating">{stats.averageRating}★</strong>{" "}
                {t("admin.statsFrom")} {stats.reviewCount} {t("admin.statsReviews")}
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
          {t("admin.tabShops")}
          {stats && stats.pendingMerchants > 0 && (
            <span className="tab-badge">{stats.pendingMerchants}</span>
          )}
        </button>
        <button
          className={`tab ${section === "categories" ? "tab-active" : ""}`}
          onClick={() => setSection("categories")}
          data-testid="admin-tab-categories"
        >
          {t("admin.tabCategories")}
        </button>
        <button
          className={`tab ${section === "orders" ? "tab-active" : ""}`}
          onClick={() => setSection("orders")}
          data-testid="admin-tab-orders"
        >
          {t("admin.tabOrders")}
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
          {t("admin.tabIgnored")}
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
          <h2>{t("admin.shops")}</h2>
          {merchants.length === 0 ? (
            <p className="muted empty">{t("admin.noShops")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("admin.thShop")}</th>
                  <th>{t("admin.thPhone")}</th>
                  <th>{t("admin.thProducts")}</th>
                  <th>{t("admin.thOrders")}</th>
                  <th>{t("admin.thStatus")}</th>
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
                        {t(`admin.status.${m.status}`)}
                      </span>
                    </td>
                    <td className="row-actions">
                      {m.status !== "APPROVED" && (
                        <button
                          disabled={busy}
                          onClick={() => act(() => api.adminSetMerchantStatus(m.id, "APPROVED"))}
                          data-testid={`approve-${m.shopName}`}
                        >
                          {t("admin.approve")}
                        </button>
                      )}
                      {m.status !== "SUSPENDED" && (
                        <button
                          className="ghost danger"
                          disabled={busy}
                          onClick={() => act(() => api.adminSetMerchantStatus(m.id, "SUSPENDED"))}
                          data-testid={`suspend-${m.shopName}`}
                        >
                          {m.status === "PENDING" ? t("admin.reject") : t("admin.suspend")}
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
          <h2>{t("admin.masterCategories")}</h2>
          <p className="muted">{t("admin.masterCategoriesSub")}</p>

          <div className="product-form">
            <div className="field">
              <label htmlFor="newCategory">{t("admin.newCategory")}</label>
              <input
                id="newCategory"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder={t("admin.newCategoryPlaceholder")}
                data-testid="new-category-name"
              />
            </div>
            <div className="field">
              <label htmlFor="newCategoryParent">{t("admin.inside")}</label>
              <select
                id="newCategoryParent"
                value={newCategoryParent}
                onChange={(e) => setNewCategoryParent(e.target.value)}
                data-testid="new-category-parent"
              >
                <option value="">{t("admin.topLevel")}</option>
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
                {t("admin.addCategory")}
              </button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>{t("admin.thCategory")}</th>
                <th>{t("admin.thProducts")}</th>
                <th>{t("admin.thSubcategories")}</th>
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
                        const name = prompt(t("admin.renamePrompt", { name: c.name }), c.name);
                        if (name) void act(() => api.adminRenameCategory(c.id, name));
                      }}
                      data-testid={`rename-${c.name}`}
                    >
                      {t("admin.rename")}
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(t("admin.deleteConfirm", { path: c.path }))) {
                          void act(() => api.adminDeleteCategory(c.id));
                        }
                      }}
                      data-testid={`delete-category-${c.name}`}
                    >
                      {t("admin.delete")}
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
            <h2>{t("admin.ignoredTitle")}</h2>
          </div>

          {ignored.length === 0 ? (
            <p className="muted empty" data-testid="admin-ignored-empty">
              {t("admin.ignoredEmpty")}
            </p>
          ) : (
            <>
              <p className="alert error" role="alert">
                {t("admin.ignoredWarning")}
              </p>
              <table data-testid="admin-ignored-table">
                <thead>
                  <tr>
                    <th>{t("admin.thWaiting")}</th>
                    <th>{t("admin.thShop")}</th>
                    <th>{t("admin.thCallShop")}</th>
                    <th>{t("admin.thCustomer")}</th>
                    <th>{t("admin.thItems")}</th>
                    <th>{t("admin.thTotal")}</th>
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
                      <td>{t("admin.jod", { value: o.totalPrice })}</td>
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
            <h2>{t("admin.allOrders")}</h2>
            <label className="muted">
              <input
                type="checkbox"
                checked={cancelledOnly}
                onChange={(e) => setCancelledOnly(e.target.checked)}
                data-testid="cancelled-only"
                style={{ width: "auto", marginRight: 6 }}
              />
              {t("admin.cancellationsOnly")}
            </label>
          </div>

          {orders.length === 0 ? (
            <p className="muted empty" data-testid="admin-no-orders">
              {t("admin.noOrders")}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("admin.thPlaced")}</th>
                  <th>{t("admin.thShop")}</th>
                  <th>{t("admin.thCustomer")}</th>
                  <th>{t("admin.thTotal")}</th>
                  <th>{t("admin.thStatus")}</th>
                  <th>{t("admin.thNotes")}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} data-testid="admin-order-row">
                    <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
                    <td>{o.shopName}</td>
                    <td className="muted">{o.customerPhone}</td>
                    <td className="price">{t("admin.jod", { value: o.totalPrice })}</td>
                    <td>
                      <span className={`badge ${o.status.toLowerCase()}`}>
                        {t(`admin.orderStatus.${o.status}`)}
                      </span>
                    </td>
                    <td className="muted">
                      {o.cancellationReason && (
                        <span data-testid="admin-order-cancel-reason">
                          {o.cancelledBy ? t(`admin.by.${o.cancelledBy.toLowerCase()}`) : ""}:{" "}
                          {o.cancellationReason}
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
