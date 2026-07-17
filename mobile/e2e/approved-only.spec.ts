/**
 * End-to-end proof that customers only ever see APPROVED shops.
 *
 * These two tests are run by scripts/verify-approved-only.sh, which flips the
 * pilot shop's status in the database between them. Run on their own they will
 * not both pass — that is intentional: each asserts one side of the rule.
 *
 *   npx playwright test approved-only --grep "hidden"   # with shop NOT approved
 *   npx playwright test approved-only --grep "visible"  # with shop approved
 */
import { expect, test, type Page } from "@playwright/test";

const SEEDED_CUSTOMER = "0791111111";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(SEEDED_CUSTOMER);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
}

test("an unapproved shop is hidden from the customer entirely", async ({ page }) => {
  await signIn(page);

  // The customer is signed in and the shop exists with 20 products — but it is
  // not approved, so they must see nothing at all.
  await expect(page.getByTestId("no-shop")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No shops open yet")).toBeVisible();

  await expect(page.getByTestId("shop-card")).toHaveCount(0);
  await expect(page.getByText("Al-Nus Dinar Shop")).toHaveCount(0);
  // Not an error state — just an honest empty shop list.
  await expect(page.getByTestId("shops-error")).toHaveCount(0);

  await page.screenshot({ path: "e2e/screenshots/approved-only-hidden.png" });
});

test("the same shop becomes visible once approved", async ({ page }) => {
  await signIn(page);

  // The pilot shop appears in the list, and its shelf is fully browsable.
  const card = page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("no-shop")).toHaveCount(0);

  await card.click();
  await expect(page.getByTestId("shop-name")).toHaveText("Al-Nus Dinar Shop", { timeout: 15_000 });
  await expect(page.getByTestId("product-item")).toHaveCount(20);
});
