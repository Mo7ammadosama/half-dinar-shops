/**
 * Typed client for the Half-Dinar Shops API — ADMIN console.
 *
 * Holds the JWT in memory + localStorage and attaches it to every request.
 *
 * This client only covers auth + the admin surface. The merchant surface
 * (products, merchant orders, uploads, AI photo entry) moved to the native
 * merchant app (merchant-app/) along with the merchant screens, so it was
 * removed here rather than left as dead, misleading code.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000/api";

// Distinct "admin" keys. This app is admin-only now, and a leftover merchant
// token from an older build of this same web app must never be picked up here
// and mistaken for a session — part of closing the old multi-role session
// ambiguity (see App.tsx).
const TOKEN_KEY = "halfdinar.admin.token";
const ROLE_KEY = "halfdinar.admin.role";

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "DELIVERING"
  | "DELIVERED"
  | "CANCELLED";

export type MerchantStatus = "PENDING" | "APPROVED" | "SUSPENDED";

export interface AdminStats {
  pendingMerchants: number;
  approvedMerchants: number;
  totalOrders: number;
  cancelledOrders: number;
  deliveredOrders: number;
  reviewCount: number;
  averageRating: string | null;
}

export interface AdminMerchant {
  id: string;
  shopName: string;
  status: MerchantStatus;
  phoneNumber: string;
  openingHours: string;
  commissionRate: string;
  productCount: number;
  orderCount: number;
  registeredAt: string;
}

export interface AdminCategory {
  id: string;
  name: string;
  parentCategoryId: string | null;
  path: string;
  productCount: number;
  subcategoryCount: number;
}

/**
 * An order a shop has not acknowledged for long enough that the admin needs to
 * step in. Derived server-side from the order's age — see escalation-policy.ts.
 */
export interface IgnoredOrder {
  id: string;
  status: OrderStatus;
  shopName: string;
  /** The admin's job here is to phone the shop. */
  shopPhone: string;
  customerPhone: string;
  totalPrice: string;
  itemCount: number;
  createdAt: string;
  waitingSeconds: number;
  escalationLevel: 0 | 1 | 2;
}

export interface AdminOrder {
  id: string;
  status: OrderStatus;
  shopName: string;
  customerPhone: string;
  totalPrice: string;
  itemCount: number;
  cancelledBy: "CUSTOMER" | "MERCHANT" | "SYSTEM" | null;
  cancellationReason: string | null;
  delivery: { captainName: string; status: string } | null;
  review: { rating: number; comment: string | null } | null;
  createdAt: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}

/**
 * The signed-in role, used to decide which screen to show.
 *
 * Display only — the API enforces roles on every request, so tampering with
 * this just produces a screen full of 403s.
 */
export function getRole(): string | null {
  return localStorage.getItem(ROLE_KEY);
}

export function setRole(role: string) {
  localStorage.setItem(ROLE_KEY, role);
}

/** Server error messages arrive either as a string or an array of strings. */
function readError(body: unknown): string {
  const message = (body as { message?: string | string[] })?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string") return message;
  return "Something went wrong. Please try again.";
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);

  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    // The token expired or was revoked — force a fresh login.
    clearToken();
    window.location.reload();
    throw new Error("Session expired. Please sign in again.");
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) throw new Error(readError(body));
  return body as T;
}

export const api = {
  requestOtp: (phoneNumber: string) =>
    call<{ expiresInSeconds: number; devCode?: string }>("/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    }),

  verifyOtp: (phoneNumber: string, code: string) =>
    call<{ accessToken: string; user: { role: string } }>("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phoneNumber, code }),
    }),

  // --- Admin (Phase 7) — ADMIN role only ---

  adminStats: () => call<AdminStats>("/admin/stats"),

  adminMerchants: (status?: MerchantStatus) =>
    call<AdminMerchant[]>(`/admin/merchants${status ? `?status=${status}` : ""}`),

  adminSetMerchantStatus: (id: string, status: MerchantStatus) =>
    call<AdminMerchant>(`/admin/merchants/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  adminCategories: () => call<AdminCategory[]>("/admin/categories"),

  adminCreateCategory: (name: string, parentCategoryId?: string) =>
    call<AdminCategory>("/admin/categories", {
      method: "POST",
      body: JSON.stringify(parentCategoryId ? { name, parentCategoryId } : { name }),
    }),

  adminRenameCategory: (id: string, name: string) =>
    call<AdminCategory>(`/admin/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  adminDeleteCategory: (id: string) =>
    call<{ deleted: boolean }>(`/admin/categories/${id}`, { method: "DELETE" }),

  adminOrders: (opts: { status?: OrderStatus; cancelledOnly?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.cancelledOnly) params.set("cancelledOnly", "true");
    const qs = params.toString();
    return call<AdminOrder[]>(`/admin/orders${qs ? `?${qs}` : ""}`);
  },

  /** Orders a shop has ignored long enough to need the admin. */
  adminIgnoredOrders: () => call<IgnoredOrder[]>("/admin/orders/ignored"),
};
