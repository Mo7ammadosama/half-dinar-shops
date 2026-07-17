/**
 * Typed client for the Half-Dinar Shops API.
 *
 * Holds the JWT in memory + localStorage and attaches it to every request.
 */

// Exported so the SSE stream (useMerchantEvents) can reach the same API without
// a second source of truth for the base URL.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000/api";
const TOKEN_KEY = "halfdinar.merchant.token";
const ROLE_KEY = "halfdinar.merchant.role";

export interface Product {
  id: string;
  name: string;
  price: string;
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId: string;
  categoryName: string | null;
  categoryPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  path: string;
}

export interface MerchantProfile {
  id: string;
  shopName: string;
  status: "PENDING" | "APPROVED" | "SUSPENDED";
  openingHours: string;
  productCount: number;
}

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
 * What the AI read from a product photo. A SUGGESTION — nothing is saved until
 * the merchant confirms the form.
 */
export interface ProductSuggestion {
  name: string;
  categoryId: string | null;
  /** Fixed-2 JOD string, or null if the AI would not guess. */
  price: string | null;
  /** 0..1. Shown to the merchant so a weak guess looks weak. */
  confidence: number;
  /** "claude" for real recognition, "mock" for the canned dev suggestions. */
  provider: string;
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

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  /** Null outside the shop's contact window — withheld by the server, not hidden here. */
  customerPhone: string | null;
  totalPrice: string;
  itemCount: number;
  unavailableCount: number;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  priceAtOrder: string;
  lineTotal: string;
  status: "CONFIRMED" | "UNAVAILABLE";
}

export type DeliveryStatus = "ASSIGNED" | "PICKED_UP" | "ON_WAY" | "DELIVERED" | "FAILED";

export interface Delivery {
  id: string;
  captainName: string;
  /** Shown in full — no masking, as specified. */
  captainPhone: string;
  status: DeliveryStatus;
  deliveredAt: string | null;
}

export interface OrderDetail {
  id: string;
  status: OrderStatus;
  /**
   * phoneNumber is null outside the shop's contact window (CONFIRMED /
   * PREPARING) — the server withholds it, so the call button cannot be
   * "unhidden" to get at a number that is not there.
   */
  customer: { id: string; phoneNumber: string | null };
  deliveryFee: string;
  totalPrice: string;
  revisedTotal: string;
  hasUnavailableItems: boolean;
  cancelledBy: "CUSTOMER" | "MERCHANT" | "SYSTEM" | null;
  cancellationReason: string | null;
  createdAt: string;
  delivery: Delivery | null;
  canAssignDelivery: boolean;
  items: OrderItem[];
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

  // FormData sets its own multipart boundary — setting Content-Type breaks it.
  if (!(init.body instanceof FormData) && init.body) {
    headers.set("Content-Type", "application/json");
  }
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

  registerMerchant: (data: {
    phoneNumber: string;
    shopName: string;
    locationLat: number;
    locationLng: number;
    openingHours: string;
  }) => call<unknown>("/merchants/register", { method: "POST", body: JSON.stringify(data) }),

  profile: () => call<MerchantProfile>("/merchants/me"),

  categories: () => call<Category[]>("/categories"),

  listProducts: (search?: string) =>
    call<Product[]>(`/products${search ? `?search=${encodeURIComponent(search)}` : ""}`),

  createProduct: (data: {
    name: string;
    price: number;
    categoryId: string;
    imageUrl?: string;
  }) => call<Product>("/products", { method: "POST", body: JSON.stringify(data) }),

  updateProduct: (
    id: string,
    data: Partial<{ name: string; price: number; categoryId: string; imageUrl: string }>,
  ) => call<Product>(`/products/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  setAvailability: (id: string, isAvailable: boolean) =>
    call<Product>(`/products/${id}/availability`, {
      method: "PATCH",
      body: JSON.stringify({ isAvailable }),
    }),

  deleteProduct: (id: string) => call<{ deleted: boolean }>(`/products/${id}`, { method: "DELETE" }),

  uploadImage: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ imageUrl: string }>("/uploads/product-image", { method: "POST", body: form });
  },

  /**
   * Reads a product photo and suggests name/category/price.
   *
   * Saves nothing — creating the product is still createProduct(), after the
   * merchant has confirmed the form.
   */
  suggestFromPhoto: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<ProductSuggestion>("/products/suggest-from-photo", { method: "POST", body: form });
  },

  // --- Order handling (Phase 5) ---

  listOrders: (status?: OrderStatus) =>
    call<OrderSummary[]>(`/merchant/orders${status ? `?status=${status}` : ""}`),

  /** Drives the new-order alarm. escalationLevel is the WORST among pending orders. */
  pendingOrderCount: () =>
    call<{ pending: number; escalationLevel: 0 | 1 | 2 }>("/merchant/orders/pending-count"),

  getOrder: (id: string) => call<OrderDetail>(`/merchant/orders/${id}`),

  setItemStatus: (orderId: string, itemId: string, status: "CONFIRMED" | "UNAVAILABLE") =>
    call<OrderDetail>(`/merchant/orders/${orderId}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  confirmOrder: (id: string) =>
    call<OrderDetail>(`/merchant/orders/${id}/confirm`, { method: "POST" }),

  startPreparing: (id: string) =>
    call<OrderDetail>(`/merchant/orders/${id}/start-preparing`, { method: "POST" }),

  /** The reason is mandatory and is shown to the customer. */
  cancelOrder: (id: string, reason: string) =>
    call<OrderDetail>(`/merchant/orders/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // --- Delivery (Phase 6) — manual, no captain app yet ---

  assignDelivery: (id: string, captainName: string, captainPhone: string) =>
    call<OrderDetail>(`/merchant/orders/${id}/delivery`, {
      method: "POST",
      body: JSON.stringify({ captainName, captainPhone }),
    }),

  /** `note` is required when marking FAILED — that cancels the order. */
  updateDelivery: (id: string, status: DeliveryStatus, note?: string) =>
    call<OrderDetail>(`/merchant/orders/${id}/delivery`, {
      method: "PATCH",
      body: JSON.stringify(note ? { status, note } : { status }),
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

/** Absolute URL for an image path returned by the API. */
/**
 * Resolves a product photo to a loadable URL.
 *
 * `image_url` is relative ("/uploads/x.jpg") when the backend stores photos on
 * local disk, and absolute ("https://cdn/x.jpg") when it uses object storage.
 * An absolute URL must pass through untouched — prepending the API base would
 * yield "http://localhost:3000https://cdn/x.jpg", silently breaking every photo
 * the moment storage moves to the cloud.
 */
export function imageSrc(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE.replace(/\/api$/, "")}${path}`;
}
