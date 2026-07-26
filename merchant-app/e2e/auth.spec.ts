/**
 * Merchant app authentication + role gate.
 *
 * Drives the real Expo app in a real browser (web target): sign in as a
 * merchant and reach the dashboard; prove a NON-merchant (customer/admin) is
 * cleanly turned away rather than shown a screen full of 403s; and prove the
 * session survives a reload and is genuinely gone after sign-out.
 *
 * TARGET: Expo's web target (react-native-web) — same components/logic the phone
 * runs, but not a native device. Camera capture and push are device-only.
 *
 * Prerequisites: API on :3000 (relaxed rate limits) and `expo start --web` on
 * :8081, database seeded.
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";

const SEEDED_MERCHANT = "0791234567";
const SEEDED_CUSTOMER = "0791111111";
const SEEDED_ADMIN = "0799999999";

/** Reserved test range — cleaned by `db:clean-test-data`. */
function reservedPhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

async function signIn(page: Page, phone: string) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(phone);
  await page.getByTestId("send-code").click();
  // Development mode prefills the code (no SMS provider yet).
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
}

test.describe("Merchant app auth", () => {
  test.beforeEach(async ({ page }) => forceEnglish(page));

  test("a seeded merchant signs in and lands on their dashboard", async ({ page }) => {
    await signIn(page, SEEDED_MERCHANT);
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("merchant-header")).toHaveText("Al-Nus Dinar Shop");
    // The two working tabs are present.
    await expect(page.getByTestId("tab-orders")).toBeVisible();
    await expect(page.getByTestId("tab-products")).toBeVisible();
  });

  test("a brand-new shop can register, then sign in to a PENDING dashboard", async ({ page }) => {
    // The headline flow for scaling: onboarding a new merchant. A "[TEST] "
    // shop name + a reserved phone are both cleaned by db:clean-test-data.
    const phone = reservedPhone();
    const shopName = `[TEST] Corner Shop ${Date.now()}`;

    await page.goto("/");
    await page.getByTestId("to-register").click();
    await page.getByTestId("reg-shop-name").fill(shopName);
    await page.getByTestId("reg-phone").fill(phone);
    await page.getByTestId("register-shop").click();

    // Registration succeeds and flips back to the sign-in step with a notice.
    await expect(page.getByText("Shop registered")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("phone-input")).toBeVisible();

    // Now sign in as that brand-new shop and land on the dashboard — which must
    // show the PENDING-approval banner, proving the pending-merchant path works.
    await page.getByTestId("phone-input").fill(phone);
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
    await page.getByTestId("verify-code").click();

    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("merchant-header")).toHaveText(shopName);
    await expect(page.getByTestId("pending-approval")).toBeVisible();
  });

  test("a wrong code is refused with a readable message", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("phone-input").fill(SEEDED_MERCHANT);
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
    await page.getByTestId("code-input").fill("000000");
    await page.getByTestId("verify-code").click();

    await expect(page.getByTestId("login-error")).toContainText("Invalid or expired code");
    await expect(page.getByTestId("merchant-header")).toHaveCount(0);
  });

  test("a CUSTOMER is cleanly turned away — this app is for shops", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);
    // Not a screenful of 403s, not a reload loop — a clear "wrong app" message.
    await expect(page.getByText("This app is for shop owners")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("merchant-header")).toHaveCount(0);
    await expect(page.getByTestId("tab-orders")).toHaveCount(0);
    // And they can leave cleanly.
    await page.getByTestId("wrong-app-signout").click();
    await expect(page.getByTestId("phone-input")).toBeVisible();
  });

  test("an ADMIN is also turned away — admins use the web dashboard", async ({ page }) => {
    await signIn(page, SEEDED_ADMIN);
    await expect(page.getByText("This app is for shop owners")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("tab-products")).toHaveCount(0);
  });

  test("the header shows WHO is signed in — never a silent, unnamed session", async ({ page }) => {
    await signIn(page, SEEDED_MERCHANT);
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
    // Identity is on screen: the signed-in phone number, from the server (/auth/me).
    await expect(page.getByTestId("signed-in-as")).toContainText("962791234567");
  });

  test("signing out and back in as a DIFFERENT shop shows the new account, not the old", async ({
    page,
  }) => {
    // The founder's exact worry: on one device, does a new login truly replace the
    // previous account, or does a stale session bleed through?
    await signIn(page, SEEDED_MERCHANT);
    await expect(page.getByTestId("merchant-header")).toHaveText("Al-Nus Dinar Shop", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("signed-in-as")).toContainText("962791234567");

    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("phone-input")).toBeVisible();

    // Register + sign in as a brand-new shop in the SAME browser.
    const phone = reservedPhone();
    const shopName = `[TEST] Second Shop ${Date.now()}`;
    await page.getByTestId("to-register").click();
    await page.getByTestId("reg-shop-name").fill(shopName);
    await page.getByTestId("reg-phone").fill(phone);
    await page.getByTestId("register-shop").click();
    await expect(page.getByText("Shop registered")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("phone-input").fill(phone);
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
    await page.getByTestId("verify-code").click();

    // The identity is the NEW shop — the previous account never shows through.
    await expect(page.getByTestId("merchant-header")).toHaveText(shopName, { timeout: 15_000 });
    await expect(page.getByTestId("merchant-header")).not.toHaveText("Al-Nus Dinar Shop");
    await expect(page.getByTestId("signed-in-as")).toContainText(phone.replace(/^0/, "962"));
  });

  test("a restored session does NOT open the shop when the server is unreachable", async ({
    page,
  }) => {
    // THE reported bug: launching before the backend is up used to restore the old
    // token and show a merchant screen nobody had signed into. Now it must show a
    // reconnect prompt, never the shell.
    await signIn(page, SEEDED_MERCHANT);
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });

    // Simulate the backend being unreachable (identity call fails at the network
    // level → the ApiError status-0 branch).
    await page.route("**/auth/me", (route) => route.abort());
    await page.reload();

    // Reconnect prompt — and crucially, NOT the shop.
    await expect(page.getByTestId("reconnect-retry")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("merchant-header")).toHaveCount(0);
    await expect(page.getByTestId("tab-products")).toHaveCount(0);

    // Backend comes up: unblock, retry → the shop appears (session was intact).
    await page.unroute("**/auth/me");
    await page.getByTestId("reconnect-retry").click();
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
  });

  test("the session survives a reload, and signing out ends it for good", async ({ page }) => {
    await signIn(page, SEEDED_MERCHANT);
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("phone-input")).toBeVisible();

    // Genuinely gone, not just visually.
    await page.reload();
    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 15_000 });
  });
});
