/**
 * Cross-app role isolation — the customer app must never act on a non-customer
 * token, however one ends up in the browser.
 *
 * Background: on the web target all apps share one origin's localStorage. The
 * token keys ARE distinct (`halfdinar.customer.token` vs `halfdinar.merchant.token`),
 * so a merchant sign-in does not bleed into the customer app (test 1 proves it).
 * The real failure was that the customer app accepted a valid MERCHANT/ADMIN
 * token in its OWN key (e.g. a tester signed into the customer app with the shop's
 * number): it browsed fine, then checkout 403'd with the raw backend string
 * "This endpoint requires the CUSTOMER role". Now such a token is caught up front
 * and the customer lands on a clean sign-in.
 *
 * TARGET: Expo web target. Prereqs: API :3000 (relaxed limits), expo web :8081.
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";
import { loginMerchant } from "./merchant-api";

const CUSTOMER_KEY = "halfdinar.customer.token";
const MERCHANT_KEY = "halfdinar.merchant.token";
const MERCHANT_NUMBER = "0791234567";

async function getMerchantToken(): Promise<string> {
  const m = await loginMerchant();
  const token = m.headers.Authorization.replace(/^Bearer /, "");
  await m.dispose();
  return token;
}

async function seedStorage(page: Page, key: string, value: string) {
  await page.addInitScript(
    ([k, v]) => localStorage.setItem(k, v),
    [key, value] as [string, string],
  );
}

test.describe("Cross-app role isolation", () => {
  test.beforeEach(async ({ page }) => forceEnglish(page));

  test("the customer app IGNORES the merchant app's token (storage is isolated)", async ({
    page,
  }) => {
    // The founder's exact repro: the merchant app signed in in this same browser,
    // leaving its token under the MERCHANT key. The customer app must not read it.
    await seedStorage(page, MERCHANT_KEY, await getMerchantToken());
    await page.goto("/");
    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("shop-card")).toHaveCount(0);
  });

  test("a non-customer token in the customer session → clean re-auth, never a raw order 403", async ({
    page,
  }) => {
    // The actual bug: a MERCHANT token sitting under the CUSTOMER key.
    await seedStorage(page, CUSTOMER_KEY, await getMerchantToken());
    await page.goto("/");

    // Caught on launch: back to sign-in with a clear reason.
    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/registered as a shop or admin/i)).toBeVisible();
    await expect(page.getByTestId("shop-card")).toHaveCount(0);
    // The raw backend role string must never reach the customer.
    await expect(page.getByText("requires the CUSTOMER role")).toHaveCount(0);
  });

  test("signing into the customer app with the shop's number is refused cleanly", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("phone-input").fill(MERCHANT_NUMBER);
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
    await page.getByTestId("verify-code").click();

    // Refused with a clear message, still on sign-in, never a signed-in shell.
    await expect(page.getByTestId("login-error")).toContainText(/registered as a shop or admin/i, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("shop-card")).toHaveCount(0);
  });
});
