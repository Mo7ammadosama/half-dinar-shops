/**
 * Customer app — the three reported blocking bugs, proven fixed.
 *
 *  #1 OTP request: a brand-new phone number can sign in end to end, and a flaky
 *     connection on the OTP request auto-retries and recovers (rather than a
 *     dead-end red error). NOTE: the on-device "Cannot reach the server" cause is
 *     API-base resolution, which needs `npm run start:remote` and cannot be tapped
 *     out without hardware; these prove the flow + the client-side hardening.
 *  #2 Stale session: a saved token the server no longer accepts lands the customer
 *     cleanly on sign-in (with a notice), NOT on a broken "signed in" shell where
 *     nothing loads.
 *  #3 Order placement: a real order placed with a valid session reaches the
 *     merchant's queue; and an order attempted with a dead token returns the
 *     customer to sign-in instead of silently failing.
 *
 * TARGET: Expo's web target (react-native-web). Prerequisites: API on :3000
 * (relaxed rate limits) and `expo start --web` on :8081, DB seeded.
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";
import { getOrder, loginMerchant, newestOrderId } from "./merchant-api";

/** Reserved test range — cleaned by `db:clean-test-data`. */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

async function signInToList(page: Page, phone: string) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(phone);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("shop-card").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Customer auth + session (the three reported bugs)", () => {
  test.beforeEach(async ({ page }) => forceEnglish(page));

  test("#1 a brand-new phone number can sign in end to end", async ({ page }) => {
    // A first-time number auto-registers as a customer and reaches the shop list.
    await signInToList(page, uniquePhone());
    await expect(page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" })).toBeVisible();
  });

  test("#1 the OTP request auto-retries a flaky connection and recovers", async ({ page }) => {
    // The backend OTP path is proven working; this proves the CLIENT no longer
    // dead-ends on a transient connection failure — it retries and gets through.
    let attempts = 0;
    await page.route("**/auth/otp/request", (route) => {
      attempts += 1;
      if (attempts <= 2) return route.abort(); // first two look like "server not up yet"
      return route.continue();
    });

    await page.goto("/");
    await page.getByTestId("phone-input").fill(uniquePhone());
    await page.getByTestId("send-code").click();

    // Despite the first two failures, the retry gets through to the code screen.
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
    expect(attempts).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("login-error")).toHaveCount(0);
  });

  test("#2 a revoked session lands on sign-in with a notice, not a broken shell", async ({
    page,
  }) => {
    // Establish a real, valid session.
    await signInToList(page, uniquePhone());

    // Now the server stops accepting that token (expired/revoked). On relaunch the
    // startup check must catch it and return to sign-in — never show the shell.
    await page.route("**/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: '{"message":"Unauthorized"}' }),
    );
    await page.reload();

    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Your session ended")).toBeVisible();
    // Crucially, NOT the signed-in shell.
    await expect(page.getByTestId("shop-card")).toHaveCount(0);
  });

  test("#3 a real order reaches the merchant's queue", async ({ page }) => {
    await signInToList(page, uniquePhone());
    await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click();
    await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("add-Chocolate Bar 30g").click();
    await page.getByTestId("plus-Chocolate Bar 30g").click(); // qty 2
    await page.getByTestId("basket-bar").click();
    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });

    // Cross-check server-side: the order the customer just placed is visible in the
    // merchant's queue with the right item count.
    const m = await loginMerchant();
    try {
      const id = await newestOrderId(m);
      const order = await getOrder(m, id);
      const choc = (order.items as Array<{ name: string; quantity: number }>).find(
        (i) => i.name === "Chocolate Bar 30g",
      );
      expect(choc?.quantity).toBe(2);
    } finally {
      await m.dispose();
    }
  });

  test("#3 an order attempted with a dead token returns the customer to sign-in", async ({
    page,
  }) => {
    await signInToList(page, uniquePhone());
    await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click();
    await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("add-Toothbrush").click();
    await page.getByTestId("basket-bar").click();

    // The token dies exactly at checkout (server rejects the order POST as 401).
    // Instead of silently failing, the customer is taken back to sign-in.
    await page.route("**/api/orders", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: '{"message":"Unauthorized"}',
        });
      }
      return route.continue();
    });
    await page.getByTestId("place-order").click();

    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Your session ended")).toBeVisible();
  });
});
