/**
 * Usability walk-through (8.3) — screenshots, not assertions.
 *
 * This project's own history is that a green tick proves nothing about whether
 * a screen makes sense: the admin Overview once read "0 orders" directly above
 * a table listing a delivered one, and every test passed. So this captures the
 * screens for a human (me) to LOOK at.
 *
 * Admin-only now — the merchant screens moved to the native merchant app, which
 * has its own screenshots under merchant-app/. Not part of the normal suite —
 * run explicitly.
 */
import { test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";

async function signIn(page: Page, phone: string) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send login code" }).click();
  await page.getByText(/Development mode: your code is/).waitFor();
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Usability walk-through", () => {
  test.setTimeout(60_000);

  test("admin: the overview", async ({ page }) => {
    await signIn(page, "0799999999");
    await page.getByTestId("admin-tab-merchants").waitFor();
    await page.screenshot({ path: `${SHOTS}/ux-admin-overview.png`, fullPage: true });
  });

  test("admin: the escalation queue", async ({ page }) => {
    await signIn(page, "0799999999");
    await page.getByTestId("admin-tab-ignored").click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/ux-admin-ignored.png`, fullPage: true });
  });
});
