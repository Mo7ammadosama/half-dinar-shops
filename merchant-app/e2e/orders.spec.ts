/**
 * Merchant order handling, driven through the real app UI.
 *
 * Each test first places a real order via the API (as a customer), then signs
 * into the merchant app and works the order: confirm it, mark an item out of
 * stock, start picking, and cancel with a reason. The cancellation/out-of-stock
 * RULES are enforced on the server; this proves the app surfaces them correctly.
 *
 * Orders are placed for a reserved-range customer (+962780000XXX). A backend
 * cleanup (see the merchant-app testing note in CLAUDE.md) removes them and the
 * stub customers afterwards so the dev DB returns to the seed.
 */
import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

const API = "http://localhost:3000/api";
const SEEDED_MERCHANT = "0791234567";

function reservedPhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

/** Places an order via the API as a fresh reserved-range customer. */
async function placeOrder(): Promise<{ orderId: string }> {
  const ctx = await playwrightRequest.newContext();
  const phone = reservedPhone();

  const otp = await (await ctx.post(`${API}/auth/otp/request`, { data: { phoneNumber: phone } })).json();
  const verify = await (
    await ctx.post(`${API}/auth/otp/verify`, { data: { phoneNumber: phone, code: otp.devCode } })
  ).json();
  const auth = { Authorization: `Bearer ${verify.accessToken}` };

  const shops = await (await ctx.get(`${API}/shops`, { headers: auth })).json();
  const shop = shops.find((s: { shopName: string }) => s.shopName === "Al-Nus Dinar Shop");
  const products = await (await ctx.get(`${API}/shops/${shop.id}/products`, { headers: auth })).json();
  const available = products.filter((p: { isAvailable: boolean }) => p.isAvailable).slice(0, 2);

  const placed = await ctx.post(`${API}/orders`, {
    headers: auth,
    data: { shopId: shop.id, items: available.map((p: { id: string }) => ({ productId: p.id, quantity: 1 })) },
  });
  const order = await placed.json();
  await ctx.dispose();
  return { orderId: order.id };
}

async function signInAndOpenOrders(page: Page) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(SEEDED_MERCHANT);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tab-orders").click();
}

test.describe("Merchant order handling", () => {
  test("a new order appears, and can be confirmed then started", async ({ page }) => {
    await placeOrder();
    await signInAndOpenOrders(page);

    // The new order shows, flagged as needing confirmation.
    const newRow = page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }).first();
    await expect(newRow).toBeVisible({ timeout: 15_000 });
    await newRow.click();

    await expect(page.getByTestId("detail-status")).toContainText("New");
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("detail-status")).toContainText("Confirmed", { timeout: 15_000 });

    await page.getByTestId("start-preparing").click();
    await expect(page.getByTestId("detail-status")).toContainText("Picking", { timeout: 15_000 });
  });

  test("marking an item out of stock does NOT cancel the order; a revised total is shown", async ({
    page,
  }) => {
    await placeOrder();
    await signInAndOpenOrders(page);

    const newRow = page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }).first();
    await newRow.click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("detail-status")).toContainText("Confirmed", { timeout: 15_000 });

    // Mark the first item out of stock.
    const firstItem = page.getByTestId("detail-item").first();
    await firstItem.getByText("Got it").click();

    // The order is still alive (a revised total appears; it is NOT cancelled).
    await expect(page.getByTestId("detail-revised")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("detail-status")).not.toContainText("Cancelled");
  });

  test("the status filter narrows the list to New orders", async ({ page }) => {
    await placeOrder();
    await signInAndOpenOrders(page);

    const newRow = page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }).first();
    await expect(newRow).toBeVisible({ timeout: 15_000 });

    // Under "New", the pending order is present.
    await page.getByTestId("orderfilter-new").click();
    await expect(
      page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }).first(),
    ).toBeVisible();

    // Under "Done", a pending order must NOT appear.
    await page.getByTestId("orderfilter-done").click();
    await expect(
      page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }),
    ).toHaveCount(0);
  });

  test("cancelling requires a reason, which the customer will see", async ({ page }) => {
    await placeOrder();
    await signInAndOpenOrders(page);

    const newRow = page.getByTestId("order-row").filter({ hasText: "New — needs confirming" }).first();
    await newRow.click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("detail-status")).toContainText("Confirmed", { timeout: 15_000 });

    await page.getByTestId("cancel-order").click();
    // The confirm button stays disabled until a real reason is typed. React
    // Native Web renders a disabled Touchable as aria-disabled (with
    // pointer-events: none), not the HTML `disabled` attribute.
    await expect(page.getByTestId("confirm-cancel")).toHaveAttribute("aria-disabled", "true");
    await page.getByTestId("cancel-reason").fill("We are closing early today");
    await page.getByTestId("confirm-cancel").click();

    await expect(page.getByTestId("detail-status")).toContainText("Cancelled", { timeout: 15_000 });
    await expect(page.getByTestId("detail-cancel-reason")).toContainText("closing early");
  });
});
