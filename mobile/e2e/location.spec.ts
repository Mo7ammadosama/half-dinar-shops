/**
 * Location permission handling, both paths.
 *
 * The requirement is "location permission handling (with manual fallback)". The
 * rule the app is built on is that **location is never a gate**: whether the
 * customer grants it, refuses it, or the device cannot provide it, they must end
 * up able to shop.
 *
 * Location now lives on the shop LIST, where it sorts shops by distance and shows
 * how far each one is. These tests therefore drive it on the list screen.
 *
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";

const SEEDED_CUSTOMER = "0791111111";

/** Signs in and lands on the shop list (the screen that owns location). */
async function signInToList(page: Page) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(SEEDED_CUSTOMER);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
  await expect(
    page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Opens the pilot shop from the list. */
async function enterPilot(page: Page) {
  await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click();
  await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 15_000 });
}

test.describe("Location granted", () => {
  // Amman, ~2km from the pilot shop at 31.9539, 35.9106.
  test.use({
    permissions: ["geolocation"],
    geolocation: { latitude: 31.97, longitude: 35.92 },
  });

  test("uses GPS and shows how far each shop is", async ({ page }) => {
    await signInToList(page);

    await page.getByTestId("location-button").click();

    await expect(page.getByTestId("place-label")).toContainText("Your location", {
      timeout: 15_000,
    });

    // Distance is computed from the real coordinates on each shop card, so it must
    // be a plausible small number of km rather than a placeholder.
    await expect(page.getByTestId("shop-distance").first()).toContainText(/\d+\.\d km away/);

    // The area picker must NOT appear when GPS succeeded.
    await expect(page.getByTestId("area-cancel")).toHaveCount(0);

    await page.screenshot({ path: "e2e/screenshots/location-granted.png" });
  });
});

test.describe("Location denied", () => {
  // No geolocation permission — the browser refuses, as a customer might.
  test.use({ permissions: [] });

  test("falls back to manual area selection and keeps shops browsable", async ({ page }) => {
    await signInToList(page);

    await page.getByTestId("location-button").click();

    // Refusal opens the manual picker rather than dead-ending.
    await expect(page.getByTestId("area-Jabal Amman")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "e2e/screenshots/location-fallback.png" });

    await page.getByTestId("area-Jabal Amman").click();

    await expect(page.getByTestId("place-label")).toHaveText("Jabal Amman");
    // The shop is still fully browsable.
    await enterPilot(page);
    await expect(page.getByTestId("product-item")).toHaveCount(20);
  });

  test("the chosen area survives a reload", async ({ page }) => {
    await signInToList(page);

    await page.getByTestId("location-button").click();
    await page.getByTestId("area-Sweifieh").click();
    await expect(page.getByTestId("place-label")).toHaveText("Sweifieh");

    await page.reload();

    await expect(page.getByTestId("place-label")).toHaveText("Sweifieh", { timeout: 15_000 });
  });

  test("dismissing the area picker still leaves shops usable", async ({ page }) => {
    await signInToList(page);

    await page.getByTestId("location-button").click();
    await expect(page.getByTestId("area-cancel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("area-cancel").click();

    // Declining everything must not block shopping.
    await expect(page.getByTestId("place-label")).toHaveText("Set delivery location");
    await enterPilot(page);
    await expect(page.getByTestId("product-item")).toHaveCount(20);
  });
});
