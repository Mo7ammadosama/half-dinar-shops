/**
 * Customer app — connection resilience on the landing screen.
 *
 * The founder hit "Cannot reach the shop right now" as a dead-end when the
 * backend was not up yet (a non-technical user starting servers in the wrong
 * order). This proves the fix: a failed shop load now shows a clear
 * can't-connect state WITH a Retry — never the misleading "no shops exist"
 * empty state — and recovers cleanly once the backend is reachable.
 *
 * TARGET: Expo's web target (react-native-web). Prerequisites: API on :3000
 * (relaxed rate limits) and `expo start --web` on :8081, database seeded.
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";

const SEEDED_CUSTOMER = "0791111111";

async function signInToList(page: Page, phone: string) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(phone);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("shop-card").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Customer connection resilience", () => {
  test.beforeEach(async ({ page }) => forceEnglish(page));

  test("an unreachable backend shows a Retry state, not a false 'no shops', and recovers", async ({
    page,
  }) => {
    // Establish a real session first (token persisted in the web store).
    await signInToList(page, SEEDED_CUSTOMER);

    // Now simulate the backend being unreachable and relaunch the app.
    await page.route("**/shops", (route) => route.abort());
    await page.reload();

    // After the auto-retry window gives up: a clear can't-connect state with a
    // Retry — and crucially NOT the "no shops exist" empty state.
    await expect(page.getByTestId("shops-load-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("no-shop")).toHaveCount(0);
    await expect(page.getByTestId("shops-error-retry")).toBeVisible();

    // Backend comes back: unblock and retry → the shop list appears.
    await page.unroute("**/shops");
    await page.getByTestId("shops-error-retry").click();
    await expect(page.getByTestId("shop-card").first()).toBeVisible({ timeout: 15_000 });
  });
});
