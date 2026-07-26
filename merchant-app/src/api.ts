/**
 * Client for the Half-Dinar Shops API — MERCHANT app.
 *
 * This is a second client for the same backend the customer app and the admin
 * dashboard talk to. No backend contract is invented here: every route below
 * already exists and is exercised by the backend e2e suite. Roles are enforced
 * on the server on every request — a customer or admin token calling these
 * merchant routes gets a 403, so this client is presentation, never security.
 */
import { Platform } from "react-native";
import Constants from "expo-constants";

/**
 * Resolves the API base URL. Same logic as the customer app (mobile/src/api.ts):
 * on a physical phone "localhost" is the phone itself, so the host is borrowed
 * from the Expo dev server's LAN address and the API port substituted.
 */
function resolveApiBase(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE;
  if (configured) return configured;

  const fromExtra = (Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase;
  if (fromExtra) return fromExtra;

  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:3000/api`;

  return "http://localhost:3000/api";
}

export const API_BASE = resolveApiBase();

export interface MerchantProfile {
  id: string;
  shopName: string;
  status: "PENDING" | "APPROVED" | "SUSPENDED";
  openingHours: string;
  productCount: number;
}

export interface Category {
  id: string;
  name: string;
  path: string;
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
  createdAt: string;
  updatedAt: string;
}

/**
 * What the AI read from a product photo. A SUGGESTION — nothing is saved until
 * the merchant confirms the form.
 */
export interface ProductSuggestion {
  name: string;
  categoryId: string | null;
  price: string | null;
  confidence: number;
  provider: string;
}

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "DELIVERING"
  | "DELIVERED"
  | "CANCELLED";

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
  captainPhone: string;
  status: DeliveryStatus;
  deliveredAt: string | null;
}

export interface OrderDetail {
  id: string;
  status: OrderStatus;
  /** phoneNumber is null outside the shop's contact window — the server withholds it. */
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

/** A photo picked from the camera or library, in the shape both platforms give us. */
export interface PickedImage {
  uri: string;
  /** e.g. "image/jpeg". expo-image-picker calls this mimeType. */
  type: string;
  /** e.g. "product.jpg". */
  name: string;
}

/** Raised for any non-2xx response, carrying a message safe to show the merchant. */
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

export function getAuthToken(): string | null {
  return authToken;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  // FormData sets its own multipart boundary — setting Content-Type breaks it.
  if (!(init.body instanceof FormData) && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("Cannot reach the server right now. Check your connection.", 0);
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) throw new ApiError(readError(body), res.status);
  return body as T;
}

/**
 * Builds a multipart body carrying an image, correctly for each platform.
 *
 * The backend validates uploads by their file signature (magic bytes), so the
 * real bytes must arrive intact — a wrong body shape silently fails that check.
 *
 *  - Native (iOS/Android): React Native's FormData accepts a { uri, name, type }
 *    part and streams the file from disk. This is the shape expo-image-picker
 *    gives us and the only shape that works on a device.
 *  - Web (the Playwright target): there is no file path to stream, so the uri
 *    (a blob:/data: URL) is fetched into a Blob and appended as a real file.
 */
async function imageForm(image: PickedImage): Promise<FormData> {
  const form = new FormData();
  if (Platform.OS === "web") {
    const blob = await (await fetch(image.uri)).blob();
    form.append("file", blob, image.name);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append("file", { uri: image.uri, name: image.name, type: image.type } as any);
  }
  return form;
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

  registerMerchant: (data: {
    phoneNumber: string;
    shopName: string;
    locationLat: number;
    locationLng: number;
    openingHours: string;
  }) => call<unknown>("/merchants/register", { method: "POST", body: JSON.stringify(data) }),

  /**
   * The signed-in identity, straight from the token. Works for ANY role and
   * never 403s — so it, not the merchant profile, is what the app uses on launch
   * to decide "is this a merchant, someone else, or a token we can't verify yet?"
   * Returning the phone number lets the app show WHO is signed in, so a restored
   * session is never a silent surprise.
   */
  me: () =>
    call<{ id: string; phoneNumber: string; role: string; merchantId: string | null }>(
      "/auth/me",
    ),

  profile: () => call<MerchantProfile>("/merchants/me"),

  // --- Push (launch blocker B6b, merchant side) ---

  /** Registers this device against the signed-in merchant, from the token. */
  registerDevice: (token: string, platform: "ios" | "android") =>
    call<void>("/auth/devices", { method: "POST", body: JSON.stringify({ token, platform }) }),

  unregisterDevice: (token: string) =>
    call<void>("/auth/devices", { method: "DELETE", body: JSON.stringify({ token }) }),

  // --- Products ---

  categories: () => call<Category[]>("/categories"),

  listProducts: (search?: string) =>
    call<Product[]>(`/products${search ? `?search=${encodeURIComponent(search)}` : ""}`),

  createProduct: (data: { name: string; price: number; categoryId: string; imageUrl?: string }) =>
    call<Product>("/products", { method: "POST", body: JSON.stringify(data) }),

  updateProduct: (
    id: string,
    data: Partial<{ name: string; price: number; categoryId: string; imageUrl: string }>,
  ) => call<Product>(`/products/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  setAvailability: (id: string, isAvailable: boolean) =>
    call<Product>(`/products/${id}/availability`, {
      method: "PATCH",
      body: JSON.stringify({ isAvailable }),
    }),

  deleteProduct: (id: string) =>
    call<{ deleted: boolean }>(`/products/${id}`, { method: "DELETE" }),

  uploadImage: async (image: PickedImage) =>
    call<{ imageUrl: string }>("/uploads/product-image", {
      method: "POST",
      body: await imageForm(image),
    }),

  /**
   * Reads a product photo and suggests name/category/price. Saves nothing —
   * the product is still created with createProduct after the merchant confirms.
   */
  suggestFromPhoto: async (image: PickedImage) =>
    call<ProductSuggestion>("/products/suggest-from-photo", {
      method: "POST",
      body: await imageForm(image),
    }),

  // --- Order handling ---

  listOrders: (status?: OrderStatus) =>
    call<OrderSummary[]>(`/merchant/orders${status ? `?status=${status}` : ""}`),

  /** Drives the new-order badge. escalationLevel is the WORST among pending orders. */
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
};

/**
 * Resolves a product photo to a loadable URL.
 *
 * Relative ("/uploads/x.jpg") when the backend stores photos on local disk;
 * absolute ("https://cdn/x.jpg") when it uses object storage. An absolute URL
 * must pass through untouched — prepending the API base would break every photo
 * the moment storage moves to the cloud.
 */
export function imageSrc(path: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE.replace(/\/api$/, "")}${path}`;
}
