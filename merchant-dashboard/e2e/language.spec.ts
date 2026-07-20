/**
 * Arabic/English switching with RTL — admin console.
 *
 * Runs against the sign-in card (no API sign-in needed): the console DEFAULTS to
 * Arabic with a right-to-left document direction, the toggle flips both strings
 * and direction, and the choice persists across a reload. On the web the browser
 * mirrors layout natively from the <html dir> attribute.
 */
import { expect, test } from "@playwright/test";
import { forceLanguage } from "./lang";

test.describe("Admin console language (AR/EN + RTL)", () => {
  test("defaults to Arabic, with right-to-left direction", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "إرسال رمز الدخول" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("switching to English flips strings AND direction, and persists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("lang-en").click();

    await expect(page.getByRole("button", { name: "Send login code" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.reload();
    await expect(page.getByRole("button", { name: "Send login code" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("English can be forced, then toggled back to Arabic (RTL returns)", async ({ page }) => {
    await forceLanguage(page, "en");
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Send login code" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByTestId("lang-ar").click();
    await expect(page.getByRole("button", { name: "إرسال رمز الدخول" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});
