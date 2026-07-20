/**
 * Phase 6 — walking an order through every delivery status, and confirming the
 * CUSTOMER app reflects each change.
 *
 * The shopkeeper side is driven through the API (see merchant-api.ts: Phase 10
 * moved the merchant UI out of the web dashboard into the standalone merchant
 * app, so this suite no longer drives a dashboard); the customer app on :8081 is
 * re-read after each step.
 *
 * Prerequisites: API :3000, expo web :8081, database seeded (incl. demo shops).
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";
import {
  assignDelivery,
  confirmOrder,
  loginMerchant,
  newestOrderId,
  startPreparing,
  updateDelivery,
} from "./merchant-api";

const CAPTAIN_NAME = "Omar Al-Zoubi";
const CAPTAIN_PHONE_TYPED = "0791122334";
/** How it is stored and shown back — normalized, never masked. */
const CAPTAIN_PHONE_SHOWN = "+962791122334";

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

/** Places an order through the customer UI. */
async function placeOrder(page: Page, itemName: string) {
  await page.getByTestId(`add-${itemName}`).click();
  await page.getByTestId("basket-bar").click();
  await page.getByTestId("place-order").click();
  await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("order-done").click();
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

test.beforeEach(async ({ page }) => forceEnglish(page));

test.describe("Manual delivery tracking", () => {
  test("an order walks through every delivery status and the customer sees each one", async ({
    page,
  }) => {
    await signInCustomer(page);
    await placeOrder(page, "Chocolate Bar 30g");

    // Merchant confirms, starts picking, and assigns a driver (via API).
    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await startPreparing(merchant, orderId);

    // --- ASSIGNED -------------------------------------------------------
    await assignDelivery(merchant, orderId, CAPTAIN_NAME, CAPTAIN_PHONE_TYPED);

    await readCustomerOrder(page);
    await expect(page.getByTestId("driver-status")).toHaveText("A driver has been assigned");
    await expect(page.getByTestId("driver-name")).toHaveText(CAPTAIN_NAME);
    // Full number, unmasked — as specified.
    await expect(page.getByTestId("driver-phone")).toHaveText(CAPTAIN_PHONE_SHOWN);
    // Still cancellable: the bag is still in the shop.
    await expect(page.getByTestId("cancel-order")).toBeVisible();
    await closeCustomerOrder(page);

    // --- PICKED_UP ------------------------------------------------------
    await updateDelivery(merchant, orderId, "PICKED_UP");

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
    await updateDelivery(merchant, orderId, "ON_WAY");

    await readCustomerOrder(page);
    await expect(page.getByTestId("driver-status")).toHaveText("Your order is on its way");
    await page.screenshot({ path: "e2e/screenshots/delivery-on-way.png", fullPage: true });
    await closeCustomerOrder(page);

    // --- DELIVERED ------------------------------------------------------
    await updateDelivery(merchant, orderId, "DELIVERED");
    await merchant.dispose();

    await readCustomerOrder(page);
    await expect(page.getByTestId("detail-status")).toHaveText("Delivered");
    await expect(page.getByTestId("driver-status")).toHaveText("Delivered");
  });

  test("a failed delivery cancels the order and the customer is told why", async ({ page }) => {
    await signInCustomer(page);
    await placeOrder(page, "Toothbrush");

    const merchant = await loginMerchant();
    const orderId = await newestOrderId(merchant);
    await confirmOrder(merchant, orderId);
    await startPreparing(merchant, orderId);
    await assignDelivery(merchant, orderId, CAPTAIN_NAME, CAPTAIN_PHONE_TYPED);
    await updateDelivery(merchant, orderId, "PICKED_UP");
    // A failed delivery needs a mandatory note; it cancels the order.
    await updateDelivery(merchant, orderId, "FAILED", "Customer did not answer the door");
    await merchant.dispose();

    await readCustomerOrder(page);
    await expect(page.getByTestId("detail-status")).toHaveText("Cancelled");
    await expect(page.getByTestId("detail-cancel-reason")).toContainText(
      "Delivery failed: Customer did not answer the door",
    );
  });

  // NOTE: "a driver cannot be assigned before the shop is picking" is a
  // server-enforced rule with no customer-app surface, so it is not re-tested
  // here. It is covered by the backend API suite (delivery e2e) and the merchant
  // UI for it by merchant-app/e2e — this suite's job is the customer's view.
});
