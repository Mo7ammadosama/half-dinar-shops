/**
 * Captures the merchant order screen for the phase report.
 *
 * Reads an order that already exists; creates nothing itself, so it leaves no
 * test data behind. Skips cleanly when the pilot shop has no orders.
 */
import { expect, test } from "@playwright/test";

test("merchant order handling screen", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Phone number").fill("0791234567");
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByTestId("tab-orders").click();

  const rows = page.getByTestId("order-row");
  // Wait for the fetch to settle: either rows arrive or the empty state does.
  // Counting immediately would race the request and always find zero.
  await expect(rows.first().or(page.getByTestId("no-orders"))).toBeVisible({ timeout: 15_000 });

  if ((await rows.count()) === 0) {
    test.skip(true, "No orders in the database to screenshot.");
    return;
  }

  await rows.first().getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("order-detail")).toBeVisible();

  await page.screenshot({ path: "e2e/screenshots/merchant-orders.png", fullPage: true });
});
