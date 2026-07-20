/**
 * Arabic/English switching with RTL — the feature this pass adds.
 *
 * Runs against the sign-in screen (no API sign-in needed), which carries the
 * language toggle and enough chrome to prove: the app DEFAULTS to Arabic with a
 * right-to-left document direction; the toggle flips both the strings and the
 * direction; and the choice PERSISTS across a reload.
 *
 * Verification limit (documented, same class as the app's other web-only caveats):
 * this proves the web target. True NATIVE layout mirroring via I18nManager.forceRTL
 * needs a device — react-native-web does not fully mirror RTL. The web `dir`
 * attribute is what makes direction real and assertable here.
 */
import { expect, test } from "@playwright/test";
import { forceLanguage } from "./lang";

test.describe("Language switching (AR/EN + RTL)", () => {
  test("defaults to Arabic, with right-to-left direction", async ({ page }) => {
    // No forced language → the app's own default (Arabic) applies.
    await page.goto("/");
    await expect(page.getByText("أدر متجرك من هاتفك.")).toBeVisible();
    await expect(page.getByTestId("send-code")).toContainText("إرسال الرمز");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("switching to English flips the strings AND the direction, and persists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("lang-en").click();

    await expect(page.getByTestId("send-code")).toContainText("Send code");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    // The choice is remembered on the device — a reload stays English/LTR.
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
