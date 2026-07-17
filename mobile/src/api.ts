/**
 * Client for the Half-Dinar Shops API.
 *
 * Customers only ever see APPROVED shops — that rule is enforced on the server
 * (see backend/src/shops/shops.service.ts), not here. The app must never be the
 * only thing standing between a customer and an unapproved shop.
 */
import Constants from "expo-constants";

/**
 * Resolves the API base URL.
 *
 * On a physical phone "localhost" means the phone itself, so the API would be
 * unreachable. Expo knows the LAN address the dev server is served from, so the
 * host is borrowed from there and the API port substituted.
 */
function resolveApiBase(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE;
  if (configured) return configured;

  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:3000/api`;

  return "http://localhost:3000/api";
}

export const API_BASE = resolveApiBase();

export interface Shop {
  id: string;
  shopName: string;
  locationLat: number;
  locationLng: number;
  openingHours: string;
  productCount: number;
}

export interface Product {
  id: string;
  name: string;
  price: string;
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId: string;
  categoryName: string | null;
  categoryPath: string | null;
}

export interface ShopCategory {
  id: string;
  name: string;
  path: string;
  productCount: number;
}

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "DELIVERING"
  | "DELIVERED"
  | "CANCELLED";

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  /** The price snapshot taken when the order was placed. */
  priceAtOrder: string;
  lineTotal: string;
  status: "CONFIRMED" | "UNAVAILABLE";
}

export type DeliveryStatus = "ASSIGNED" | "PICKED_UP" | "ON_WAY" | "DELIVERED" | "FAILED";

export interface Delivery {
  captainName: string;
  /** The driver's real number — shown in full, no masking. */
  captainPhone: string;
  status: DeliveryStatus;
  statusLabel: string;
  deliveredAt: string | null;
}

export interface Review {
  id: string;
  rating: number;
  comment: string | null;
}

/**
 * Phone numbers, gated by the server to the moment they are useful.
 *
 * Outside its window a number is null — the server does not send it at all.
 */
export interface OrderContact {
  /** The shop, while they are preparing the order. */
  shopPhone: string | null;
  /** The driver, while they are carrying the order. */
  driverPhone: string | null;
  driverName: string | null;
}

export interface Order {
  id: string;
  status: OrderStatus;
  shop: { id: string; shopName: string };
  contact: OrderContact;
  review: Review | null;
  canReview: boolean;
  /** Null until the shop assigns a driver. */
  delivery: Delivery | null;
  itemsTotal: string;
  deliveryFee: string;
  totalPrice: string;
  /** What the total becomes once out-of-stock items are removed. */
  revisedTotal: string;
  hasUnavailableItems: boolean;
  unavailableItemNames: string[];
  canCancel: boolean;
  /** True when the shop is already picking — the app must warn first. */
  cancelRequiresWarning: boolean;
  cancelBlockedReason: string | null;
  cancelledBy: "CUSTOMER" | "MERCHANT" | "SYSTEM" | null;
  cancellationReason: string | null;
  createdAt: string;
  paymentMethod: "cash_on_delivery";
  items: OrderItem[];
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  shopName: string;
  totalPrice: string;
  itemCount: number;
  createdAt: string;
}

/** Raised for any non-2xx response, carrying a message safe to show a customer. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Server errors arrive either as a string or an array of strings. */
function readError(body: unknown): string {
  const message = (body as { message?: string | string[] })?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string") return message;
  return "Something went wrong. Please try again.";
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    // fetch only rejects on a network-level failure.
    throw new ApiError("Cannot reach the shop right now. Check your connection.", 0);
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) throw new ApiError(readError(body), res.status);
  return body as T;
}

export const api = {
  requestOtp: (phoneNumber: string) =>
    call<{ expiresInSeconds: number; devCode?: string }>("/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    }),

  verifyOtp: (phoneNumber: string, code: string) =>
    call<{ accessToken: string; user: { id: string; phoneNumber: string; role: string } }>(
      "/auth/otp/verify",
      { method: "POST", body: JSON.stringify({ phoneNumber, code }) },
    ),

  /**
   * Registers this device for order notifications (launch blocker B6).
   *
   * The device is attached to the signed-in caller server-side, from the token
   * — there is no userId in the body to tamper with.
   */
  registerDevice: (token: string, platform: "ios" | "android") =>
    call<void>("/auth/devices", {
      method: "POST",
      body: JSON.stringify({ token, platform }),
    }),

  /** Stops this device receiving notifications. Called on sign-out. */
  unregisterDevice: (token: string) =>
    call<void>("/auth/devices", { method: "DELETE", body: JSON.stringify({ token }) }),

  /** Only ever returns shops the customer is allowed to see. */
  listShops: () => call<Shop[]>("/shops"),

  listProducts: (shopId: string, filters: { search?: string; categoryId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    const qs = params.toString();
    return call<Product[]>(`/shops/${shopId}/products${qs ? `?${qs}` : ""}`);
  },

  listShopCategories: (shopId: string) => call<ShopCategory[]>(`/shops/${shopId}/categories`),

  /** The delivery fee, so the cart can show a total before checkout. */
  quote: () => call<{ deliveryFee: string; paymentMethod: string }>("/orders/quote"),

  /**
   * Places an order. Only product ids and quantities are sent — never prices.
   * The server reads the real price from the database and snapshots it.
   */
  placeOrder: (shopId: string, items: Array<{ productId: string; quantity: number }>) =>
    call<Order>("/orders", { method: "POST", body: JSON.stringify({ shopId, items }) }),

  listOrders: () => call<OrderSummary[]>("/orders"),

  getOrder: (id: string) => call<Order>(`/orders/${id}`),

  /** Cancels the customer's own order, subject to the status rules. */
  cancelOrder: (id: string, reason?: string) =>
    call<Order>(`/orders/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  /** Accepts removal of out-of-stock items; the total recalculates now. */
  acceptOrderChanges: (id: string) =>
    call<Order>(`/orders/${id}/accept-changes`, { method: "POST" }),

  /** Leaves a review. Only after delivery, and only once. */
  reviewOrder: (id: string, rating: number, comment?: string) =>
    call<Order>(`/orders/${id}/review`, {
      method: "POST",
      body: JSON.stringify(comment?.trim() ? { rating, comment } : { rating }),
    }),
};

/** Absolute URL for a product photo path. */
/**
 * Resolves a product photo to a loadable URL.
 *
 * `image_url` comes in two shapes depending on where the backend stores photos:
 *   - local disk (dev):        "/uploads/x.jpg"       — relative, served by the API
 *   - object storage (prod):   "https://cdn/x.jpg"    — absolute, not served by us
 *
 * An absolute URL must pass through untouched. Prepending the API base to it
 * would produce "http://localhost:3000https://cdn/x.jpg" and every photo would
 * silently fail to load the day storage moves to the cloud — no error, just
 * broken images.
 */
export function imageSrc(path: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE.replace(/\/api$/, "")}${path}`;
}
