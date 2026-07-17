import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  clearToken,
  imageSrc,
  type Category,
  type MerchantProfile,
  type Product,
  type ProductSuggestion,
} from "./api";
import { NewOrderAlert } from "./NewOrderAlert";
import { Orders } from "./Orders";
import { useMerchantEvents } from "./useMerchantEvents";

/** Blank form state for the add/edit product form. */
const EMPTY_FORM = { name: "", price: "", categoryId: "", imageUrl: "" };

export function Dashboard() {
  const [profile, setProfile] = useState<MerchantProfile | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<ProductSuggestion | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<"orders" | "products">("orders");
  const [pendingOrders, setPendingOrders] = useState(0);
  const [pendingEscalation, setPendingEscalation] = useState<0 | 1 | 2>(0);

  /**
   * Ask once for permission to show desktop notifications.
   *
   * Only asked after sign-in, when the shopkeeper is demonstrably here to work
   * — a permission prompt on a login screen gets dismissed on reflex, and
   * "denied" is sticky. If they refuse, the sound, the banner and the tab title
   * all still work; this is one channel of four, not the mechanism.
   */
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    void Notification.requestPermission().catch(() => {
      // Refusing is a legitimate answer, not an error.
    });
  }, []);

  const loadProducts = useCallback(async (term: string) => {
    try {
      setProducts(await api.listProducts(term || undefined));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [p, c] = await Promise.all([api.profile(), api.categories()]);
        setProfile(p);
        setCategories(c);
        await loadProducts("");
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [loadProducts]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void loadProducts(search), 250);
    return () => clearTimeout(t);
  }, [search, loadProducts]);

  /**
   * Re-reads the pending count from the server.
   *
   * The server is always the authority. An event says "look again", it never
   * carries the count itself — otherwise a missed or duplicated event would
   * leave the badge lying, and the alarm is only as trustworthy as the number
   * behind it.
   */
  const refreshPending = useCallback(async () => {
    try {
      const { pending, escalationLevel } = await api.pendingOrderCount();
      setPendingOrders(pending);
      setPendingEscalation(escalationLevel ?? 0);
    } catch {
      // A failed badge refresh must not interrupt the shopkeeper's work.
    }
  }, []);

  /**
   * Live events: a new order lights the alarm immediately rather than up to 10
   * seconds later. See useMerchantEvents for why this is fetch and not
   * EventSource.
   */
  const { connected: streamConnected } = useMerchantEvents(
    useCallback(
      (event) => {
        if (event.type === "order.new" || event.type === "order.escalation") {
          void refreshPending();
        }
      },
      [refreshPending],
    ),
  );

  /**
   * The poll stays, deliberately.
   *
   * It is the floor under the alert: if the stream is down, connected to
   * another instance, or blocked by a proxy that buffers text/event-stream, the
   * shopkeeper still sees the order within 10 seconds. The stream makes alerts
   * immediate; the poll makes them certain. Missing an order is the worst
   * failure in this product, so it gets a belt and braces.
   */
  useEffect(() => {
    void refreshPending();
    const t = setInterval(() => void refreshPending(), 10_000);
    return () => clearInterval(t);
  }, [tab, refreshPending]);

  async function refreshProfileCount() {
    try {
      setProfile(await api.profile());
    } catch {
      // A stale product count is not worth surfacing an error for.
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        price: Number(form.price),
        categoryId: form.categoryId,
        ...(form.imageUrl ? { imageUrl: form.imageUrl } : {}),
      };

      if (editingId) {
        await api.updateProduct(editingId, payload);
      } else {
        await api.createProduct(payload);
      }

      setForm(EMPTY_FORM);
      // A suggestion about the previous product must not linger over the next.
      setSuggestion(null);
      setEditingId(null);
      if (fileRef.current) fileRef.current.value = "";
      await loadProducts(search);
      await refreshProfileCount();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * One action: the photo is stored AND read.
   *
   * A shop has thousands of items. Photographing one and having the name,
   * category and price appear — to check rather than type — is the difference
   * between a catalogue that gets finished and one that gets abandoned. The
   * merchant was going to add the photo anyway, so recognition is free of any
   * extra step.
   */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setSuggestion(null);

    try {
      const { imageUrl } = await api.uploadImage(file);
      setForm((f) => ({ ...f, imageUrl }));
    } catch (err) {
      setError((err as Error).message);
      if (fileRef.current) fileRef.current.value = "";
      setUploading(false);
      return;
    }
    setUploading(false);

    // Recognition is a separate, optional step: the photo is already saved, so
    // a failure here costs nothing but the convenience. Never surfaced as an
    // error — the merchant just types, exactly as before.
    setSuggesting(true);
    try {
      const result = await api.suggestFromPhoto(file);
      setSuggestion(result);

      // Only fills fields that are EMPTY. Overwriting something the merchant
      // already typed would make a helpful feature into one that destroys
      // their work — and they would stop trusting it immediately.
      setForm((f) => ({
        ...f,
        name: f.name || result.name,
        price: f.price || result.price || "",
        categoryId: f.categoryId || result.categoryId || "",
      }));
    } catch {
      // Silent: the photo saved, and typing still works.
    } finally {
      setSuggesting(false);
    }
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      price: product.price,
      categoryId: product.categoryId,
      imageUrl: product.imageUrl ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleToggle(product: Product) {
    setError(null);
    try {
      await api.setAvailability(product.id, !product.isAvailable);
      await loadProducts(search);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(product: Product) {
    if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteProduct(product.id);
      await loadProducts(search);
      await refreshProfileCount();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function signOut() {
    clearToken();
    window.location.reload();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            Half-Dinar <span>Shops</span>
          </h1>
          {profile && (
            <p className="muted">
              {profile.shopName} · {profile.productCount} products ·{" "}
              <span className={`badge ${profile.status.toLowerCase()}`}>{profile.status}</span>
            </p>
          )}
        </div>
        <button className="ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      {/*
        Directly under the header, above everything else: a new order outranks
        whatever the shopkeeper is currently doing. It does not dismiss itself.
      */}
      <NewOrderAlert
        pendingCount={pendingOrders}
        escalationLevel={pendingEscalation}
        streamConnected={streamConnected}
        onAcknowledge={() => setTab("orders")}
      />

      {profile?.status === "PENDING" && (
        <div className="alert notice">
          Your shop is awaiting admin approval. You can build your product list now — customers will
          see it once you are approved.
        </div>
      )}

      <nav className="tabs">
        <button
          className={`tab ${tab === "orders" ? "tab-active" : ""}`}
          onClick={() => setTab("orders")}
          data-testid="tab-orders"
        >
          Orders
          {pendingOrders > 0 && (
            <span className="tab-badge" data-testid="pending-badge">
              {pendingOrders}
            </span>
          )}
        </button>
        <button
          className={`tab ${tab === "products" ? "tab-active" : ""}`}
          onClick={() => setTab("products")}
          data-testid="tab-products"
        >
          Products
        </button>
      </nav>

      {tab === "orders" ? (
        <Orders />
      ) : (
        <>
      {error && (
        <div className="alert error" role="alert" data-testid="error">
          {error}
        </div>
      )}

      <section className="card">
        <h2>{editingId ? "Edit product" : "Add a product"}</h2>
        <form onSubmit={handleSubmit} className="product-form">
          <div className="field">
            <label htmlFor="name">Product name</label>
            <input
              id="name"
              name="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Dish Sponge (2 pcs)"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="price">Price (JOD)</label>
            <input
              id="price"
              name="price"
              type="number"
              step="0.01"
              min="0"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="0.50"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="categoryId">Category</label>
            <select
              id="categoryId"
              name="categoryId"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              required
            >
              <option value="">Choose a category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="photo">Photo — we'll fill in the rest</label>
            <input
              id="photo"
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleUpload}
            />
            {uploading && <span className="muted">Uploading…</span>}
            {suggesting && (
              <span className="muted" data-testid="suggesting">
                Reading the photo…
              </span>
            )}
            {form.imageUrl && !uploading && !suggesting && (
              <span className="muted" data-testid="upload-ok">
                Photo attached ✓
              </span>
            )}
          </div>

          {/*
            The suggestion is presented as something to CHECK, never as a
            finished answer. Confidence is shown plainly — a weak guess must
            look weak, or the merchant stops reading and starts trusting, and
            a wrong price reaches a real customer.
          */}
          {suggestion && !suggesting && (
            <div
              className={`suggestion${suggestion.confidence < 0.5 ? " suggestion-unsure" : ""}`}
              data-testid="ai-suggestion"
            >
              <div className="suggestion-head">
                <strong>
                  {suggestion.confidence < 0.5
                    ? "Not sure what this is — please fill it in"
                    : "Filled in from the photo — please check"}
                </strong>
                <span className="suggestion-confidence" data-testid="ai-confidence">
                  {Math.round(suggestion.confidence * 100)}% confident
                </span>
              </div>
              <p className="suggestion-note">
                {suggestion.provider === "mock"
                  ? "Demo mode: this is a canned example, not real recognition."
                  : "Correct anything that is wrong before saving — nothing is saved yet."}
              </p>
            </div>
          )}

          <div className="actions">
            <button type="submit" disabled={busy || uploading}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Add product"}
            </button>
            {editingId && (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                  setSuggestion(null);
      // A suggestion about the previous product must not linger over the next.
      setSuggestion(null);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card">
        <div className="list-head">
          <h2>Your products ({products.length})</h2>
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            aria-label="Search products"
          />
        </div>

        {products.length === 0 ? (
          <p className="muted empty">No products yet. Add your first one above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Photo</th>
                <th>Name</th>
                <th>Price</th>
                <th>Category</th>
                <th>Available</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} data-testid="product-row">
                  <td>
                    {p.imageUrl ? (
                      <img className="thumb" src={imageSrc(p.imageUrl)!} alt="" />
                    ) : (
                      <div className="thumb placeholder" />
                    )}
                  </td>
                  <td className="name">{p.name}</td>
                  <td className="price">{p.price} JOD</td>
                  <td className="muted">{p.categoryPath}</td>
                  <td>
                    <button
                      className={`toggle ${p.isAvailable ? "on" : "off"}`}
                      onClick={() => handleToggle(p)}
                      aria-label={`Toggle availability for ${p.name}`}
                    >
                      {p.isAvailable ? "In stock" : "Out of stock"}
                    </button>
                  </td>
                  <td className="row-actions">
                    <button className="ghost" onClick={() => startEdit(p)}>
                      Edit
                    </button>
                    <button className="ghost danger" onClick={() => handleDelete(p)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
        </>
      )}
    </div>
  );
}
