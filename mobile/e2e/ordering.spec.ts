/**
 * Phase 4 — placing an order through the real customer app.
 *
 * Drives the actual UI: add items, open the basket, check the totals, place the
 * order, and confirm what the shop received.
 *
 * Prerequisites: API on :3000, expo web on :8081, database seeded.
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";

/** Reserved test range — see backend `npm run db:clean-test-data`. */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

async function signIn(page: Page, phone = uniquePhone()) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(phone);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
  await page.getByTestId("verify-code").click();
  // The app now opens on the shop list; enter the pilot shop.
  await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 20_000 });
  return phone;
}

test.describe("Placing an order", () => {
  test("a customer can fill a basket and place a cash-on-delivery order", async ({ page }) => {
    await signIn(page);

    // 2 x Chocolate Bar (0.50) = 1.00
    await page.getByTestId("add-Chocolate Bar 30g").click();
    await expect(page.getByTestId("qty-Chocolate Bar 30g")).toHaveText("1");
    await page.getByTestId("plus-Chocolate Bar 30g").click();
    await expect(page.getByTestId("qty-Chocolate Bar 30g")).toHaveText("2");

    // + 1 x Aluminium Foil Roll (0.90) = 1.90 items total
    await page.getByTestId("add-Aluminium Foil Roll").click();

    await expect(page.getByTestId("basket-count")).toHaveText("3");
    await expect(page.getByTestId("basket-total")).toHaveText("1.90 JOD");

    await page.getByTestId("basket-bar").click();

    // The summary must show items, delivery and the true total.
    await expect(page.getByTestId("summary-items")).toHaveText("1.90 JOD");
    await expect(page.getByTestId("summary-delivery")).toHaveText("0.50 JOD");
    await expect(page.getByTestId("summary-total")).toHaveText("2.40 JOD");
    await expect(page.getByTestId("payment-method")).toContainText("cash on delivery");

    await page.getByTestId("place-order").click();

    // The confirmation repeats back exactly what the shop received.
    await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("placed-items-total")).toHaveText("1.90 JOD");
    await expect(page.getByTestId("placed-delivery")).toHaveText("0.50 JOD");
    await expect(page.getByTestId("placed-total")).toHaveText("2.40 JOD");
    await expect(page.getByTestId("placed-item")).toHaveCount(2);
    await expect(page.getByTestId("placed-status")).toContainText("Waiting for the shop to confirm");

    await page.screenshot({ path: "e2e/screenshots/order-placed.png", fullPage: true });
  });

  test("the basket empties once the order is placed, so it cannot be sent twice", async ({
    page,
  }) => {
    await signIn(page);

    await page.getByTestId("add-Toothbrush").click();
    await page.getByTestId("basket-bar").click();
    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("order-done").click();

    // Back on the shop: no basket bar, because the basket is empty.
    await expect(page.getByTestId("basket-bar")).toHaveCount(0);
    await expect(page.getByTestId("add-Toothbrush")).toBeVisible();
  });

  test("the basket survives closing and reopening the app", async ({ page }) => {
    await signIn(page);

    await page.getByTestId("add-Bar Soap 100g").click();
    await page.getByTestId("plus-Bar Soap 100g").click();
    await expect(page.getByTestId("basket-total")).toHaveText("1.00 JOD");

    await page.reload();

    // A reload lands back on the shop list; re-open the pilot shop. The basket
    // must still be there — restored from storage, not held in memory.
    await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click({ timeout: 20_000 });
    await expect(page.getByTestId("basket-count")).toHaveText("2", { timeout: 20_000 });
    await expect(page.getByTestId("basket-total")).toHaveText("1.00 JOD");
    await expect(page.getByTestId("qty-Bar Soap 100g")).toHaveText("2");
  });

  test("items can be removed from the basket, and the total follows", async ({ page }) => {
    await signIn(page);

    await page.getByTestId("add-Wooden Spoon").click();
    await page.getByTestId("plus-Wooden Spoon").click();
    await page.getByTestId("plus-Wooden Spoon").click();
    await expect(page.getByTestId("basket-total")).toHaveText("1.50 JOD");

    await page.getByTestId("basket-bar").click();
    await expect(page.getByTestId("cart-line-total-Wooden Spoon")).toHaveText("1.50 JOD");

    await page.getByTestId("cart-minus-Wooden Spoon").click();
    await expect(page.getByTestId("cart-qty-Wooden Spoon")).toHaveText("2");
    await expect(page.getByTestId("summary-items")).toHaveText("1.00 JOD");
    await expect(page.getByTestId("summary-total")).toHaveText("1.50 JOD");

    // Removing the last one empties the basket.
    await page.getByTestId("cart-minus-Wooden Spoon").click();
    await page.getByTestId("cart-minus-Wooden Spoon").click();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
  });

  test("out-of-stock items cannot be added to the basket at all", async ({ page }) => {
    await signIn(page);

    const energy = page.getByTestId("product-item").filter({ hasText: "Energy Drink 250ml" });
    await expect(energy.getByTestId("out-of-stock")).toBeVisible();

    // No Add button on an out-of-stock item.
    await expect(page.getByTestId("add-Energy Drink 250ml")).toHaveCount(0);
  });

  test("a basket of many half-dinar items totals exactly, with no rounding drift", async ({
    page,
  }) => {
    await signIn(page);

    // 7 x 0.50 = 3.50 exactly; floats would risk 3.4999999999999996.
    await page.getByTestId("add-Chocolate Bar 30g").click();
    for (let i = 0; i < 6; i++) {
      await page.getByTestId("plus-Chocolate Bar 30g").click();
    }

    await expect(page.getByTestId("qty-Chocolate Bar 30g")).toHaveText("7");
    await expect(page.getByTestId("basket-total")).toHaveText("3.50 JOD");

    await page.getByTestId("basket-bar").click();
    await expect(page.getByTestId("summary-items")).toHaveText("3.50 JOD");
    await expect(page.getByTestId("summary-total")).toHaveText("4.00 JOD");

    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("placed-total")).toHaveText("4.00 JOD", { timeout: 20_000 });
  });
});
