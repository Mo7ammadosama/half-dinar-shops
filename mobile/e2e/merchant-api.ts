/**
 * Drives the MERCHANT side of a shared-lifecycle test through the API, not a UI.
 *
 * Why the API and not a second app window: through Phase 9 these customer-app
 * specs drove the shopkeeper's *web dashboard* on :5173. Phase 10 moved every
 * merchant screen OUT of that dashboard into the standalone `merchant-app/` (the
 * dashboard is admin-only now), which silently broke these specs — they were
 * clicking `tab-orders` on a console that no longer has it.
 *
 * The UNIQUE value of these customer-app specs is proving the CUSTOMER app
 * reflects each order/delivery change. The merchant UI itself is now covered by
 * `merchant-app/e2e/`. So the counterpart here is driven the same way
 * `merchant-app/e2e/orders.spec.ts` sets its orders up — straight against the
 * API — which is faster and does not depend on any second UI being served.
 */
import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";

const API = "http://localhost:3000/api";
export const PILOT_MERCHANT_PHONE = "0791234567";

export type MerchantApi = {
  ctx: APIRequestContext;
  headers: Record<string, string>;
  dispose: () => Promise<void>;
};

/** Signs a merchant in via OTP (dev returns the code) and returns an auth context. */
export async function loginMerchant(phone: string = PILOT_MERCHANT_PHONE): Promise<MerchantApi> {
  const ctx = await playwrightRequest.newContext();
  const otp = await (await ctx.post(`${API}/auth/otp/request`, { data: { phoneNumber: phone } })).json();
  const verifyRes = await ctx.post(`${API}/auth/otp/verify`, {
    data: { phoneNumber: phone, code: otp.devCode },
  });
  expect(verifyRes.ok(), "merchant OTP verify should succeed").toBeTruthy();
  const body = await verifyRes.json();
  return {
    ctx,
    headers: { Authorization: `Bearer ${body.accessToken}` },
    dispose: () => ctx.dispose(),
  };
}

/** The id of the merchant's most recently placed order (serial tests → the one just placed). */
export async function newestOrderId(m: MerchantApi): Promise<string> {
  const res = await m.ctx.get(`${API}/merchant/orders`, { headers: m.headers });
  expect(res.ok()).toBeTruthy();
  const orders: Array<{ id: string; createdAt: string }> = await res.json();
  orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (orders.length === 0) throw new Error("merchant has no orders to work");
  return orders[0].id;
}

export async function getOrder(m: MerchantApi, id: string) {
  const res = await m.ctx.get(`${API}/merchant/orders/${id}`, { headers: m.headers });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function post(m: MerchantApi, path: string, data?: unknown) {
  const res = await m.ctx.post(`${API}${path}`, { headers: m.headers, data: data ?? {} });
  expect(res.ok(), `POST ${path} should succeed (got ${res.status()})`).toBeTruthy();
  return res.json();
}
async function patch(m: MerchantApi, path: string, data: unknown) {
  const res = await m.ctx.patch(`${API}${path}`, { headers: m.headers, data });
  expect(res.ok(), `PATCH ${path} should succeed (got ${res.status()})`).toBeTruthy();
  return res.json();
}

export const confirmOrder = (m: MerchantApi, id: string) =>
  post(m, `/merchant/orders/${id}/confirm`);
export const startPreparing = (m: MerchantApi, id: string) =>
  post(m, `/merchant/orders/${id}/start-preparing`);
export const cancelOrder = (m: MerchantApi, id: string, reason: string) =>
  post(m, `/merchant/orders/${id}/cancel`, { reason });
export const assignDelivery = (m: MerchantApi, id: string, captainName: string, captainPhone: string) =>
  post(m, `/merchant/orders/${id}/delivery`, { captainName, captainPhone });
export const updateDelivery = (m: MerchantApi, id: string, status: string, note?: string) =>
  patch(m, `/merchant/orders/${id}/delivery`, note ? { status, note } : { status });

/** Marks the named line item out of stock (looks the item id up from the order). */
export async function setItemUnavailableByName(m: MerchantApi, id: string, name: string) {
  const order = await getOrder(m, id);
  const item = (order.items as Array<{ id: string; name: string }>).find((i) => i.name === name);
  if (!item) throw new Error(`item "${name}" not found on order ${id}`);
  return patch(m, `/merchant/orders/${id}/items/${item.id}`, { status: "UNAVAILABLE" });
}

/** Registers a brand-new shop (PENDING) and returns nothing — used by the lifecycle spec. */
export async function registerShop(data: {
  phoneNumber: string;
  shopName: string;
  locationLat: number;
  locationLng: number;
  openingHours: string;
}) {
  const ctx = await playwrightRequest.newContext();
  const res = await ctx.post(`${API}/merchants/register`, { data });
  expect(res.ok(), `register shop should succeed (got ${res.status()})`).toBeTruthy();
  await ctx.dispose();
}

/** Adds a product to the signed-in merchant's own shop, resolving the category by name. */
export async function addProductByCategoryName(
  m: MerchantApi,
  data: { name: string; price: number; categoryName: string },
) {
  const cats: Array<{ id: string; name: string; path: string }> = await (
    await m.ctx.get(`${API}/categories`, { headers: m.headers })
  ).json();
  const cat = cats.find((c) => c.name === data.categoryName || c.path === data.categoryName);
  if (!cat) throw new Error(`category "${data.categoryName}" not found`);
  return post(m, `/products`, { name: data.name, price: data.price, categoryId: cat.id });
}
