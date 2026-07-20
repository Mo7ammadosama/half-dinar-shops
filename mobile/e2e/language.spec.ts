/**
 * Arabic/English switching with RTL — customer app.
 *
 * Runs against the sign-in screen (no API sign-in needed): the app DEFAULTS to
 * Arabic with a right-to-left document direction, the toggle flips both strings
 * and direction, and the choice persists across a reload.
 *
 * Verification limit (same class as the app's other web-only caveats): this
 * proves the web target. True NATIVE layout mirroring via I18nManager.forceRTL
 * needs a device — react-native-web does not fully mirror RTL.
 */
import { expect, test } from "@playwright/test";
import { forceLanguage } from "./lang";

test.describe("Language switching (AR/EN + RTL)", () => {
  test("defaults to Arabic, with right-to-left direction", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("كل ما تحتاجه، على مقربة منك.")).toBeVisible();
    await expect(page.getByTestId("send-code")).toContainText("إرسال الرمز");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("switching to English flips the strings AND the direction, and persists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("lang-en").click();

    await expect(page.getByTestId("send-code")).toContainText("Send code");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.reload();
    await expect(page.getByTestId("send-code")).toContainText("Send code");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("English can be forced, then toggled back to Arabic (RTL returns)", async ({ page }) => {
    await forceLanguage(page, "en");
    await page.goto("/");
    await expect(page.getByTestId("send-code")).toContainText("Send code");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByTestId("lang-ar").click();
    await expect(page.getByTestId("send-code")).toContainText("إرسال الرمز");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});
