/**
 * Phase 5 — the full order cycle across BOTH real UIs.
 *
 * The customer app runs on :8081 and the merchant dashboard on :5173, so a
 * single test can drive a real order from both sides: the customer places it,
 * the shopkeeper works it in their dashboard, and the customer sees the result.
 *
 * Prerequisites: API :3000, expo web :8081, dashboard :5173, database seeded.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const DASHBOARD = "http://localhost:5173";

/**
 * Opens the merchant dashboard in its OWN desktop-sized context.
 *
 * This project renders at a Pixel 7 viewport because the customer app is a phone
 * app — but the dashboard is a desktop web app a shopkeeper uses on a laptop.
 * Rendering it at phone width collapses its table and makes cells overlap the
 * buttons, which is a bug in the test setup, not in the dashboard.
 */
async function openDashboard(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

/** Reserved test range — cleaned by backend `npm run db:clean-test-data`. */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

/** The seeded pilot merchant. */
const MERCHANT_PHONE = "0791234567";

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

/** Signs into the merchant dashboard (a separate app on its own origin). */
async function signInMerchant(page: Page) {
  await page.goto(`${DASHBOARD}/`);
  await page.getByLabel("Phone number").fill(MERCHANT_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("tab-orders")).toBeVisible({ timeout: 20_000 });
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

/** Opens the newest order in the merchant dashboard. */
async function openNewestOrder(merchant: Page) {
  await merchant.getByTestId("tab-orders").click();
  await expect(merchant.getByTestId("order-row").first()).toBeVisible({ timeout: 20_000 });
  await merchant.getByTestId("order-row").first().getByRole("button", { name: "Open" }).click();
  await expect(merchant.getByTestId("order-detail")).toBeVisible();
}

test.describe("Full order cycle across both apps", () => {
  test("customer orders, shop confirms and picks, customer sees each step", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Chocolate Bar 30g", extra: 1 }]);

    // The customer sees it waiting for the shop.
    await page.getByTestId("open-orders").click();
    await expect(page.getByTestId("row-status").first()).toHaveText(
      "Waiting for the shop to confirm",
    );
    await page.getByTestId("orders-close").click();

    // The shopkeeper picks it up in the dashboard.
    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openNewestOrder(merchant);

    await expect(merchant.getByTestId("detail-status")).toHaveText("New — needs confirming");
    await merchant.getByTestId("confirm-order").click();
    await expect(merchant.getByTestId("detail-status")).toHaveText("Confirmed");

    await merchant.getByTestId("start-preparing").click();
    await expect(merchant.getByTestId("detail-status")).toHaveText("Picking items");

    // The customer sees the new status.
    await page.getByTestId("open-orders").click();
    await expect(page.getByTestId("row-status").first()).toHaveText(
      "The shop is picking your items",
    );

    await merchant.close();
  });

  test("an out-of-stock item does not cancel the order, and the total only changes when the customer accepts", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    // Chocolate 2 x 0.50 = 1.00 + Foil 0.90 = 1.90 items, + 0.50 = 2.40
    await placeOrder(page, [{ name: "Chocolate Bar 30g", extra: 1 }, { name: "Aluminium Foil Roll" }]);

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openNewestOrder(merchant);

    await merchant.getByTestId("confirm-order").click();
    await merchant.getByTestId("start-preparing").click();

    // The shopkeeper cannot find the foil.
    await merchant.getByTestId("item-toggle-Aluminium Foil Roll").click();
    await expect(merchant.getByTestId("item-toggle-Aluminium Foil Roll")).toHaveText("Out of stock");

    // The order is alive, and the dashboard shows the revised figure.
    await expect(merchant.getByTestId("detail-status")).toHaveText("Picking items");
    await expect(merchant.getByTestId("detail-revised")).toHaveText("Revised 1.50 JOD");
    // The charged total has NOT changed yet.
    await expect(merchant.getByTestId("detail-totals")).toContainText("Total 2.40 JOD");

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

    await merchant.close();
  });

  test("the customer can cancel freely while the order is still pending", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Toothbrush" }]);

    await page.getByTestId("open-orders").click();
    await page.getByTestId("order-row").first().click();

    await page.getByTestId("cancel-order").click();

    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled", { timeout: 20_000 });
  });

  test("cancelling once the shop is picking asks the customer to confirm first", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Bar Soap 100g" }]);

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openNewestOrder(merchant);
    await merchant.getByTestId("confirm-order").click();
    await merchant.getByTestId("start-preparing").click();
    await merchant.close();

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

  test("the shop cancels with a reason, and the customer sees exactly that reason", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, [{ name: "Wooden Spoon" }]);

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openNewestOrder(merchant);
    await merchant.getByTestId("confirm-order").click();

    await merchant.getByTestId("cancel-order").click();

    // The reason is mandatory — the button stays disabled until it is real.
    await expect(merchant.getByTestId("confirm-cancel")).toBeDisabled();
    await merchant.getByTestId("cancel-reason").fill("We are closing early today");
    await expect(merchant.getByTestId("confirm-cancel")).toBeEnabled();
    await merchant.getByTestId("confirm-cancel").click();

    await expect(merchant.getByTestId("detail-status")).toHaveText("Cancelled");
    await merchant.close();

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
  // in the UI can move an order to DELIVERING until Phase 6 builds it, so any
  // test here would assert something other than its name — a green tick that
  // proves nothing. The rule is covered properly in the API suite
  // (order-cycle.e2e-spec.ts) and gets its UI test in Phase 6.
});
