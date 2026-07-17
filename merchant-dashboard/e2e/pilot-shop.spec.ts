/**
 * Signs in as the seeded pilot shop (Al-Nus Dinar Shop) and checks its real
 * catalogue renders.
 *
 * Unlike dashboard.spec.ts this creates nothing — it reads the seeded data, so
 * it leaves no test rows behind. It is the closest thing to "what the actual
 * shopkeeper sees when they log in".
 */
import { expect, test } from "@playwright/test";

const PILOT_PHONE = "0791234567";

test("the seeded pilot shop sees its 20 products", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Phone number").fill(PILOT_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Al-Nus Dinar Shop")).toBeVisible();

  // The dashboard opens on Orders; this test is about the product catalogue.
  await page.getByTestId("tab-products").click();
  // An approved shop must not show the pending-approval banner.
  await expect(page.getByText("awaiting admin approval")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Your products (20)" })).toBeVisible();
  await expect(page.getByTestId("product-row")).toHaveCount(20);

  // The seeded out-of-stock item must render as out of stock.
  const energyDrink = page.getByTestId("product-row").filter({ hasText: "Energy Drink 250ml" });
  await expect(energyDrink.getByRole("button", { name: /Toggle availability/ })).toHaveText(
    "Out of stock",
  );

  await page.screenshot({ path: "e2e/screenshots/pilot-shop.png", fullPage: true });
});
