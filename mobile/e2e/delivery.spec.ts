/**
 * Phase 6 — walking an order through every delivery status by hand, and
 * confirming the customer app reflects each change.
 *
 * Drives both real UIs: the shopkeeper's dashboard moves the delivery along, the
 * customer app is re-read after each step.
 *
 * Prerequisites: API :3000, expo web :8081, dashboard :5173, database seeded.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const DASHBOARD = "http://localhost:5173";
const MERCHANT_PHONE = "0791234567";

const CAPTAIN_NAME = "Omar Al-Zoubi";
const CAPTAIN_PHONE_TYPED = "0791122334";
/** How it is stored and shown back — normalized, never masked. */
const CAPTAIN_PHONE_SHOWN = "+962791122334";

/** Reserved test range — cleaned by backend `npm run db:clean-test-data`. */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

/** The dashboard is a laptop app; give it a desktop viewport. */
async function openDashboard(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
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

async function signInMerchant(page: Page) {
  await page.goto(`${DASHBOARD}/`);
  await page.getByLabel("Phone number").fill(MERCHANT_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("tab-orders")).toBeVisible({ timeout: 20_000 });
}

/** Places an order through the customer UI. */
async function placeOrder(page: Page, itemName: string) {
  await page.getByTestId(`add-${itemName}`).click();
  await page.getByTestId("basket-bar").click();
  await page.getByTestId("place-order").click();
  await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("order-done").click();
}

/** Opens the newest order in the dashboard and gets it to PREPARING. */
async function openAndPrepare(merchant: Page) {
  await merchant.getByTestId("tab-orders").click();
  await expect(merchant.getByTestId("order-row").first()).toBeVisible({ timeout: 20_000 });
  await merchant.getByTestId("order-row").first().getByRole("button", { name: "Open" }).click();
  await expect(merchant.getByTestId("order-detail")).toBeVisible();
  await merchant.getByTestId("confirm-order").click();
  await merchant.getByTestId("start-preparing").click();
}

/** Re-opens the customer's newest order to read live state. */
async function readCustomerOrder(page: Page) {
  await page.getByTestId("open-orders").click();
  await page.getByTestId("order-row").first().click();
}

/** Closes the customer's order detail and list. */
async function closeCustomerOrder(page: Page) {
  await page.getByTestId("orders-close").click(); // back to list
  await page.getByTestId("orders-close").click(); // close list
}

test.describe("Manual delivery tracking", () => {
  test("an order walks through every delivery status and the customer sees each one", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, "Chocolate Bar 30g");

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openAndPrepare(merchant);

    // --- ASSIGNED -------------------------------------------------------
    await merchant.getByTestId("captain-name").fill(CAPTAIN_NAME);
    await merchant.getByTestId("captain-phone").fill(CAPTAIN_PHONE_TYPED);
    await merchant.getByTestId("assign-delivery").click();

    await expect(merchant.getByTestId("delivery-status")).toHaveText("Driver assigned");
    // The order itself has not left yet.
    await expect(merchant.getByTestId("detail-status")).toHaveText("Picking items");

    await readCustomerOrder(page);
    await expect(page.getByTestId("driver-status")).toHaveText("A driver has been assigned");
    await expect(page.getByTestId("driver-name")).toHaveText(CAPTAIN_NAME);
    // Full number, unmasked — as specified.
    await expect(page.getByTestId("driver-phone")).toHaveText(CAPTAIN_PHONE_SHOWN);
    // Still cancellable: the bag is still in the shop.
    await expect(page.getByTestId("cancel-order")).toBeVisible();
    await closeCustomerOrder(page);

    // --- PICKED_UP ------------------------------------------------------
    await merchant.getByTestId("delivery-to-PICKED_UP").click();
    await expect(merchant.getByTestId("delivery-status")).toHaveText("Driver collected it");
    await expect(merchant.getByTestId("detail-status")).toHaveText("Out for delivery");

    await readCustomerOrder(page);
    await expect(page.getByTestId("driver-status")).toHaveText(
      "The driver has collected your order",
    );
    await expect(page.getByTestId("detail-status")).toHaveText("On its way to you");
    // Cancellation is now blocked — the goods have left.
    await expect(page.getByTestId("cancel-order")).toHaveCount(0);
    await expect(page.getByTestId("cancel-blocked")).toContainText("on its way");
    await closeCustomerOrder(page);

    // --- ON_WAY ---------------------------------------------------------
    await merchant.getByTestId("delivery-to-ON_WAY").click();
    await expect(merchant.getByTestId("delivery-status")).toHaveText("On the way");

    await readCustomerOrder(page);
    await expect(page.getByTestId("driver-status")).toHaveText("Your order is on its way");
    await page.screenshot({ path: "e2e/screenshots/delivery-on-way.png", fullPage: true });
    await closeCustomerOrder(page);

    // --- DELIVERED ------------------------------------------------------
    await merchant.getByTestId("delivery-to-DELIVERED").click();
    await expect(merchant.getByTestId("delivery-status")).toHaveText("Delivered");
    await expect(merchant.getByTestId("detail-status")).toHaveText("Delivered");

    await readCustomerOrder(page);
    await expect(page.getByTestId("detail-status")).toHaveText("Delivered");
    await expect(page.getByTestId("driver-status")).toHaveText("Delivered");

    await merchant.close();
  });

  test("a failed delivery cancels the order and the customer is told why", async ({
    page,
    browser,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, "Toothbrush");

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await openAndPrepare(merchant);

    await merchant.getByTestId("captain-name").fill(CAPTAIN_NAME);
    await merchant.getByTestId("captain-phone").fill(CAPTAIN_PHONE_TYPED);
    await merchant.getByTestId("assign-delivery").click();
    await merchant.getByTestId("delivery-to-PICKED_UP").click();

    await merchant.getByTestId("delivery-fail").click();
    // The note is mandatory — it cancels the order.
    await expect(merchant.getByTestId("confirm-fail")).toBeDisabled();
    await merchant.getByTestId("fail-note").fill("Customer did not answer the door");
    await merchant.getByTestId("confirm-fail").click();

    await expect(merchant.getByTestId("delivery-status")).toHaveText("Delivery failed");
    await expect(merchant.getByTestId("detail-status")).toHaveText("Cancelled");

    await readCustomerOrder(page);
    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled");
    await expect(page.getByTestId("detail-cancel-reason")).toContainText(
      "Delivery failed: Customer did not answer the door",
    );

    await merchant.close();
  });

  test("a driver cannot be assigned before the shop is picking", async ({ page, browser }) => {
    await signInCustomer(page);
    await placeOrder(page, "Bar Soap 100g");

    const merchant = await openDashboard(browser);
    await signInMerchant(merchant);
    await merchant.getByTestId("tab-orders").click();
    await expect(merchant.getByTestId("order-row").first()).toBeVisible({ timeout: 20_000 });
    await merchant.getByTestId("order-row").first().getByRole("button", { name: "Open" }).click();

    // Still new: no assign box at all.
    await expect(merchant.getByTestId("detail-status")).toHaveText("New — needs confirming");
    await expect(merchant.getByTestId("assign-delivery-box")).toHaveCount(0);

    await merchant.close();
  });
});
