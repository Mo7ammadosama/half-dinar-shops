/**
 * Phase 5 — the full order cycle, proving the CUSTOMER app reflects each step.
 *
 * The customer app runs on :8081; the merchant side is driven through the API
 * (see merchant-api.ts for why — Phase 10 moved the merchant UI out of the web
 * dashboard into the standalone merchant app, so this suite no longer drives a
 * dashboard). A single test still walks a real order end to end: the customer
 * places it in the app, the shopkeeper works it via the API, and the customer app
 * is re-read to prove it shows the result.
 *
 * Prerequisites: API :3000, expo web :8081, database seeded (incl. demo shops).
 */
import { expect, test, type Page } from "@playwright/test";
import {
  cancelOrder,
  confirmOrder,
  loginMerchant,
  newestOrderId,
  setItemUnavailableByName,
  startPreparing,
} from "./merchant-api";

/** Reserved test range — cleaned by backend `npm run db:clean-test-data`. */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

async function signInCustomer(page: Page) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(uniquePhone());
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
  await page.getByTestId("verify-code").click();
  // The app now opens on the shop list; enter the pilot shop.
  await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 20_000 });
}

/** Places an order in the customer app and returns nothing — the UI drives it. */
async function placeOrder(page: Page, items: Array<{ name: string; extra?: number }>) {
  for (const item of items) {
    await page.getByTestId(`add-${item.name}`).click();
    for (let i = 0; i < (item.extra ?? 0); i++) {
      await page.getByTestId(`plus-${item.name}`).click();
    }
  }
  await page.getByTestId("basket-bar").click();
  await page.getByTestId("place-order").click();
  await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("order-done").click();
}

test.describe("Full order cycle across both apps", () => {
  test("customer orders, shop confirms and picks, customer sees each step", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Chocolate Bar 30g", extra: 1 }]);

    // The customer sees it waiting for the shop.
    await page.getByTestId("open-orders").click();
    await expect(page.getByTestId("row-status").first()).toHaveText(
      "Waiting for the shop to confirm",
    );
    await page.getByTestId("orders-close").click();

    // The shopkeeper picks it up (via the API — the merchant app's own UI is
    // covered by merchant-app/e2e).
    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await startPreparing(merchant, orderId);
    await merchant.dispose();

    // The customer sees the new status.
    await page.getByTestId("open-orders").click();
    await expect(page.getByTestId("row-status").first()).toHaveText(
      "The shop is picking your items",
    );
  });

  test("an out-of-stock item does not cancel the order, and the total only changes when the customer accepts", async ({
    page,
  }) => {
    await signInCustomer(page);
    // Chocolate 2 x 0.50 = 1.00 + Foil 0.90 = 1.90 items, + 0.50 = 2.40
    await placeOrder(page, [{ name: "Chocolate Bar 30g", extra: 1 }, { name: "Aluminium Foil Roll" }]);

    // The shop confirms, starts picking, then cannot find the foil.
    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await startPreparing(merchant, orderId);
    await setItemUnavailableByName(merchant, orderId, "Aluminium Foil Roll");
    await merchant.dispose();

    // The customer is told, and sees the old total plus what it would become.
    await page.getByTestId("open-orders").click();
    await page.getByTestId("order-row").first().click();
    await expect(page.getByTestId("unavailable-notice")).toBeVisible();
    await expect(page.getByTestId("revised-total")).toHaveText("1.50 JOD");
    await expect(page.getByTestId("detail-total")).toHaveText("2.40 JOD");

    await page.screenshot({ path: "e2e/screenshots/order-unavailable.png", fullPage: true });

    // They accept -> only now does the total change.
    await page.getByTestId("accept-changes").click();
    await expect(page.getByTestId("detail-total")).toHaveText("1.50 JOD", { timeout: 20_000 });
    await expect(page.getByTestId("unavailable-notice")).toHaveCount(0);
    await expect(page.getByTestId("detail-item")).toHaveCount(1);
    // Still being prepared — not cancelled.
    await expect(page.getByTestId("detail-status")).toHaveText("The shop is picking your items");
  });

  test("the customer can cancel freely while the order is still pending", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Toothbrush" }]);

    await page.getByTestId("open-orders").click();
    await page.getByTestId("order-row").first().click();

    await page.getByTestId("cancel-order").click();

    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled", { timeout: 20_000 });
  });

  test("cancelling once the shop is picking asks the customer to confirm first", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Bar Soap 100g" }]);

    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await startPreparing(merchant, orderId);
    await merchant.dispose();

    await page.getByTestId("open-orders").click();
    await page.getByTestId("order-row").first().click();

    // Dismiss the warning -> the order must survive.
    page.once("dialog", (d) => d.dismiss());
    await page.getByTestId("cancel-order").click();
    await expect(page.getByTestId("detail-status")).toHaveText("The shop is picking your items");

    // Accept the warning -> now it cancels.
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("cancel-order").click();
    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled", { timeout: 20_000 });
  });

  test("the shop cancels with a reason, and the customer sees exactly that reason", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Wooden Spoon" }]);

    // The shop confirms, then cancels with a mandatory reason (the "reason is
    // required" rule itself is enforced server-side and covered by the API and
    // merchant-app suites; here we prove the customer SEES the reason).
    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await cancelOrder(merchant, orderId, "We are closing early today");
    await merchant.dispose();

    // The customer sees the cancellation AND the shop's reason.
    await page.getByTestId("open-orders").click();
    await page.getByTestId("order-row").first().click();
    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled");
    await expect(page.getByTestId("detail-cancel-reason")).toContainText(
      "We are closing early today",
    );

    await page.screenshot({ path: "e2e/screenshots/order-cancelled.png", fullPage: true });
  });

  // NOTE: "cancellation is blocked once DELIVERING" is NOT tested here. Nothing
  // in the customer UI can move an order to DELIVERING on its own, and the rule
  // is covered in the API suite (order-cycle.e2e-spec.ts) and exercised via the
  // delivery spec below.
});
