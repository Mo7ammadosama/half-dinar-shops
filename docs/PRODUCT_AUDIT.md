# Product Audit — Half-Dinar Shops Marketplace

> A real requirements-and-quality review of all three apps (customer, merchant, admin),
> written **before** any fixes, so there is a record of what was found and why each change was
> prioritised. Companion to the work logged in `PHASE_REPORTS.md §13`.
>
> **Date:** 2026-07-26 · **Author:** autonomous review pass · **Method:** stack brought up live
> and journeys walked against the running backend, not read from code alone.

---

## 0. How this audit was done (the gate)

Nothing below is a code-read guess. The full stack was brought up first and exercised:

- **Postgres + Redis** (Docker) — already healthy on host ports 5433 / 6380.
- **Backend API** on `:3000` — booted clean; Redis-backed rate limiting confirmed in the log.
- **Merchant login walked over the real API:** OTP request → `devCode` returned → verify →
  `role: MERCHANT` → `GET /merchants/me` (shop "Al-Nus Dinar Shop", APPROVED, 20 products) →
  `GET /products` **returned all 20 products**.
- **Admin login walked:** `role: ADMIN` → `GET /admin/stats` and `GET /admin/merchants` returned.

**The single most important empirical finding:** the merchant product-list API returns all 20
products. So the founder's report *"there is no page where I can see my products"* is **not** a
missing feature and **not** a backend failure — the screen and data both exist. Its root cause is
diagnosed in §4.

---

## 1. Inventory — every screen and every action that exists today

### Customer app (`mobile/`, Expo/React Native)

| Screen | Actions available |
|---|---|
| **LoginScreen** | Enter phone → request code → enter 6-digit code → sign in. First-time number auto-registers a customer (no separate signup — by design). AR/EN toggle. |
| **ShopsScreen** (landing) | List all APPROVED shops, sorted nearest-first with per-shop distance; grant location or pick a manual area; open a shop; sign out; AR/EN toggle. |
| **BrowseScreen** (storefront) | Category filter chips, search, product cards with price + emoji placeholder, add to cart, cart badge, back. |
| **CartScreen** | Line items, qty +/−, remove, delivery fee, total, place cash-on-delivery order. |
| **OrderPlacedScreen** | Confirmation; view order status. |
| **OrdersScreen** | List own orders, per-order status, item statuses, call-shop button (gated to window), call-driver button (gated), review after delivery. |

### Merchant app (`merchant-app/`, Expo/React Native)

| Screen | Actions available |
|---|---|
| **LoginScreen** | Sign in (phone+OTP) **or** register a new shop (name, phone, opening hours → PENDING). AR/EN toggle. |
| **App shell** | Header with shop name + product-count/status; PENDING-approval banner; Orders/Products tabs; new-order badge; sign out; AR/EN toggle. Role gate: a customer/admin sees "this app is for shop owners". |
| **OrdersScreen (list)** | Status filter (All/New/Active/Done + counts), relative time, "waiting N min" urgency, pull-to-refresh + Refresh button + "last updated", open an order. |
| **OrdersScreen (detail)** | Per-item Got-it / Out-of-stock, confirm order, start picking, cancel-with-reason, call customer (gated), assign driver, drive delivery status ASSIGNED→…→DELIVERED / FAILED-with-note, revised total. |
| **ProductsScreen** | Add/edit form; **photo → AI auto-fill** (camera or library); **full product list** with search, availability filter (All/In/Out + counts), sort (recent/name/price), out-of-stock warning banner, availability toggle with Undo, edit, delete-with-confirmation. Success toasts. |

### Admin console (`merchant-dashboard/`, React web — admin-only since Phase 10)

| Screen | Actions available |
|---|---|
| **Login** | Admin phone+OTP. Non-admin → clean "this console is for administrators". AR/EN toggle. |
| **Admin** | Overview stats; Shops (approve/suspend); Categories (master list CRUD); All orders / cancellations / reviews (read). |

**Conclusion of the inventory:** the products are all present and, per feature count, mature. The
apps are Phase-12-complete. The problems reported are **not "we never built X"** — they are
**trust, discoverability, and failure-mode** problems. That reframing drives the priorities below.

---

## 2. Journey walk-throughs and friction points

### Customer: browse → order → track → receive

- ✅ Auto-registration on first phone entry works and is the right call (no friction).
- ⚠️ **Dead-end on a cold backend.** If the API is not up yet, the first screen shows
  *"Cannot reach the shop right now. Check your connection."* with **no retry** — the user must
  force-quit and relaunch. For a non-technical founder starting servers in the wrong order this is
  the exact wall they hit. **[P1 — FIX]** See §4.C.
- ⚠️ No explicit "you are signed in as 07…" anywhere; low-trust but low-severity for a customer.

### Merchant: register → manage products → handle orders → hand off

- ⚠️ **Session opens into a previous account with no login.** On launch the saved token restores
  silently and, on **any** non-401 error from the profile call (**including a status-0 "server
  unreachable"**), the app keeps `role = MERCHANT` and renders the shell with the **fallback** shop
  name. Combined with a cold backend, the shopkeeper sees a merchant screen they never logged into.
  **[P0 — FIX]** Root cause + fix in §4.A.
- ⚠️ **"There's no product list."** The Products tab opens on the **Add/Edit form first**; the list
  is below it, and if the initial `GET /products` failed (cold backend) the list area shows the
  empty state. Nothing tells the merchant to scroll, and nothing surfaces the real reason the list
  is empty. **[P1 — FIX]** §4.B.
- ⚠️ **No visible identity of who is logged in.** The header shows the shop name (or a fallback);
  it never shows the signed-in phone number, so "is this even my account?" cannot be answered from
  the screen. **[P1 — FIX]**
- ➕ Everything else in the merchant loop (orders, items, cancel, delivery, AI entry) is complete
  and was exercised.

### Admin: approve shops → monitor → resolve

- ✅ Approve/suspend, categories, order/review visibility all present.
- ⚠️ Same cold-backend dead-end class on the login screen. Lower priority (the admin is the most
  technical user and runs on a desktop next to the server). **[P2]**

---

## 3. What a real, competent version of this business still needs

Measured against "can a shopkeeper comfortably run their shop through this all day, does a customer
trust it, can an admin operate it" — and deliberately scoped to the **single-shop pilot**, not a
marketplace at scale.

| Gap | App | Verdict |
|---|---|---|
| Trustworthy session identity (see who you're signed in as; never a silent stale session) | Merchant (+customer) | **Build now** — it is the reported bug and a real trust issue. |
| Graceful "still starting up" / retry instead of a dead-end connection error | All three | **Build now** — reported, and hits non-technical users every cold start. |
| Product list discoverable without scrolling past the add-form | Merchant | **Build now** — reframe the Products tab around the list. |
| Per-product **stock quantity** | Merchant | **Defer, logged decision.** The schema has only a binary `is_available`; there is no quantity column. Adding real stock counts is a schema + order-decrement feature, not a bug fix, and half-dinar variety shops restock constantly — binary in/out matches how they actually work. Not built this pass. |
| Server-side i18n for push/validation text | All | **Defer** — already logged as a Phase-12 follow-up. |
| Multi-shop admin tooling (bulk actions, per-shop drill-down) | Admin | **Defer** — pilot is one shop by design. |

---

## 4. The three reported bugs — root cause and planned fix

### 4.A — Merchant session auto-restores into "an account that isn't mine" **[P0]**

**Root cause (verified in `merchant-app/App.tsx`).** `refreshProfile()` handles the profile call:
`403 → NOT_MERCHANT`, `401 → signOut`, **everything else → `setRole("MERCHANT")` (stay in)**. A
status-0 "cannot reach server" lands in that `else`, so launching before the backend is up keeps
the old token and shows the merchant shell with the fallback name. Persisted login is a legitimate
feature, but *showing merchant UI when we could not confirm the session* is not.

**Fix:**
1. Treat a **status-0 / network error** during startup restore as "cannot verify yet": show a
   dedicated *reconnecting* state with a **Retry**, not the merchant shell. Only a **confirmed**
   profile (2xx) reveals the shell; a confirmed 401/403 routes to sign-out / wrong-app.
2. **Show the signed-in phone number** in the header and on the wrong-app screen, so identity is
   never a guess.
3. Keep sign-out clearing **every** stored copy (already does; will be re-proven).

**Proof:** extend `e2e/auth.spec.ts` — sequential logins as two different accounts on one device
(sign in A → sign out → sign in B → header shows B, not A), and a startup-with-backend-unreachable
test that must **not** show the shell. Web-verified; keystore-on-device noted as B4-class pending.

### 4.B — "No product list" **[P1]**

**Root cause:** not missing — `ProductsScreen` renders a full searchable/filterable/sortable list.
It is (a) below the add-form and (b) empty-and-unexplained when the initial load failed.

**Fix:** make the list the primary content — put an **"+ Add product" toggle** at the top that
opens the form on demand, so the tab opens on the *list*; and when the list load fails, show the
real error with a **Retry** instead of the bare "no products" empty state.

### 4.C — "Cannot reach the shop right now" is a dead-end **[P1]**

**Root cause:** `api.ts` maps a fetch failure to a status-0 `ApiError` with a static message; every
screen shows it as terminal text with no way forward.

**Fix (as shipped):**
- **Customer** (where this exact string appears, and the highest-traffic cold-start path): a shared
  `withConnectRetry` helper (status-0 only, ~6s linear backoff, GET-only) on the ShopsScreen landing
  load, with a **"Still connecting…"** spinner, so a cold backend self-heals within a few seconds; and
  the misleading "no shops exist" empty state is replaced by a distinct **can't-connect + Retry** state.
- **Merchant:** the startup path is gated by the session-verify rewrite (§4.A), which routes an
  unreachable backend to a **reconnect screen with a manual Retry** (not the shell); the Products list
  also gained a **manual Retry** on load failure. These kill the dead-end; they are manual, not
  auto-retry — deliberately, since the merchant is already being asked to confirm identity.
- **Admin console:** not changed this pass (§2 — the admin is the most technical user, on a desktop
  next to the server; lowest priority).

---

## 5. Priorities (what this pass will actually change)

1. **[P0]** Merchant startup session: reconnecting state, no stale shell, visible identity. (4.A)
2. **[P1]** Connection UX: **auto-retry** on the customer landing load + a **manual Retry** reconnect
   path on the merchant (admin unchanged) — no more dead-ends on a cold backend. (4.C)
3. **[P1]** Merchant Products tab: list-first, add behind a toggle, real error + Retry. (4.B)
4. **[P1]** Show signed-in phone identity (merchant header + wrong-app + customer shops header).
5. **Re-test + attack** everything, re-verify the session bug cannot reproduce, commit, push. (Part 4)

Explicitly **not** in this pass (logged decisions): stock-quantity tracking, server-side i18n,
multi-shop admin tooling. Rationale in §3.
