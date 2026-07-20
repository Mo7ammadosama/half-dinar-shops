/**
 * Admin console auth + the admin-only gate.
 *
 * The dashboard used to host BOTH the merchant dashboard and the admin panel in
 * one browser, sharing one localStorage token — so "sign in as merchant, then as
 * admin" in the same browser clobbered the first session. Merchants have moved
 * to their own app; this app is admin-only, so there is exactly one role that
 * belongs here and the ambiguity is gone.
 *
 * This suite proves the gate: an admin gets in; a NON-admin (merchant/customer)
 * is turned away cleanly — a clear message and a sign-out, NOT the deleted
 * merchant screens, NOT a screenful of 403s, NOT a reload loop.
 *
 * Prerequisites: API on :3000 (relaxed rate limits), dashboard dev server on
 * :5173, database seeded.
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";

const ADMIN = "0799999999";
const MERCHANT = "0791234567";
const CUSTOMER = "0791111111";

async function signIn(page: Page, phone: string) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Admin console auth", () => {
  test.beforeEach(async ({ page }) => forceEnglish(page));

  test("a seeded admin signs in and sees the admin panel", async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByTestId("admin-header")).toBeVisible();
    await expect(page.getByTestId("admin-tab-merchants")).toBeVisible();
  });

  test("a MERCHANT is turned away cleanly — no merchant screens, no 403 storm", async ({ page }) => {
    await signIn(page, MERCHANT);
    await expect(page.getByTestId("not-admin")).toBeVisible();
    await expect(page.getByTestId("not-admin")).toContainText("administrators only");
    // The admin panel must NOT render, and there must be no old merchant tabs.
    await expect(page.getByTestId("admin-tab-merchants")).toHaveCount(0);
    await expect(page.getByTestId("tab-products")).toHaveCount(0);
    // A clean way out.
    await page.getByTestId("not-admin-sign-out").click();
    await expect(page.getByLabel("Phone number")).toBeVisible();
  });

  test("a CUSTOMER is turned away the same way", async ({ page }) => {
    await signIn(page, CUSTOMER);
    await expect(page.getByTestId("not-admin")).toBeVisible();
    await expect(page.getByTestId("admin-tab-merchants")).toHaveCount(0);
  });

  test("the admin session survives a reload, and sign-out ends it", async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByTestId("admin-header")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("admin-header")).toBeVisible();

    await page.getByTestId("admin-sign-out").click();
    await expect(page.getByLabel("Phone number")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Phone number")).toBeVisible();
  });

  test("signing in as a merchant then as an admin in one browser is not confused", async ({
    page,
  }) => {
    // The exact scenario from the bug report: two roles, one browser, one after
    // the other. Each sign-in must land on the correct screen for THAT role —
    // the merchant is turned away, and the subsequent admin sign-in works.
    await signIn(page, MERCHANT);
    await expect(page.getByTestId("not-admin")).toBeVisible();
    await page.getByTestId("not-admin-sign-out").click();
    await expect(page.getByLabel("Phone number")).toBeVisible();

    await signIn(page, ADMIN);
    await expect(page.getByTestId("admin-header")).toBeVisible();
    await expect(page.getByTestId("admin-tab-merchants")).toBeVisible();
  });
});
