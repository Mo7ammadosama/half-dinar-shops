/**
 * The "nearest shop" experience.
 *
 * Proves the customer sees MULTIPLE shops, sorted by how near they are, with the
 * distance shown for each — the whole point of task 1. Distance is computed on
 * the device from each shop's coordinates and the customer's location.
 *
 * NEEDS THE DEMO SHOPS: from backend/, run `npm run seed:demo` (they are
 * "[TEST] "-marked and removed by `npm run db:clean-test-data`). Rather than fail
 * red on a freshly-cleaned database with only the pilot shop, these tests SKIP
 * themselves when there are fewer than two shops — so the default suite stays
 * green either way, and the sort is genuinely exercised whenever the demo data is
 * present. (A suite that is permanently red just teaches everyone to ignore red.)
 *
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";

const SEEDED_CUSTOMER = "0791111111";

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

test.beforeEach(async ({ page }) => forceEnglish(page));

test.describe("Nearest shop", () => {
  // Stand exactly on the pilot shop's coordinates (downtown Al-Balad), so the
  // pilot is the nearest (0.0 km) and the demo shops fan out from there.
  test.use({
    permissions: ["geolocation"],
    geolocation: { latitude: 31.9539, longitude: 35.9106 },
  });

  test("lists shops sorted nearest-first, each showing its distance", async ({ page }) => {
    await signInToList(page);

    // Only meaningful with multiple shops. Skip (green) rather than fail if the
    // demo shops have not been seeded (`npm run seed:demo`).
    const shopCount = await page.getByTestId("shop-card").count();
    test.skip(shopCount < 2, "needs the demo shops — run `npm run seed:demo` in backend/");

    // Grant location — the list re-sorts by distance and shows km per shop.
    await page.getByTestId("location-button").click();
    await expect(page.getByTestId("place-label")).toContainText("Your location", {
      timeout: 15_000,
    });

    const distances = page.getByTestId("shop-distance");
    const count = await distances.count();
    expect(count).toBeGreaterThan(1);

    // Every shown distance parses to a plausible km value...
    const texts = await distances.allInnerTexts();
    const nums = texts.map((t) => parseFloat(t));
    for (const n of nums) expect(Number.isFinite(n)).toBe(true);

    // ...and the list is ordered nearest-first (non-decreasing distance).
    const ascending = [...nums].sort((a, b) => a - b);
    expect(nums).toEqual(ascending);

    // The nearest card is the pilot itself — we are standing on it (0.0 km).
    const firstCard = page.getByTestId("shop-card").first();
    await expect(firstCard).toContainText("Al-Nus Dinar Shop");
    await expect(firstCard.getByTestId("shop-distance")).toContainText("0.0 km away");

    await page.screenshot({ path: "e2e/screenshots/shops-nearest.png", fullPage: true });
  });

  test("opening a shop from the list shows that shop's shelf", async ({ page }) => {
    await signInToList(page);

    // Open a demo shop (not the pilot) and confirm we land on ITS storefront.
    const demo = page.getByTestId("shop-card").filter({ hasText: "Shmeisani Corner Store" });
    test.skip((await demo.count()) === 0, "needs the demo shops — run `npm run seed:demo` in backend/");
    await expect(demo).toBeVisible();
    await demo.click();

    await expect(page.getByTestId("shop-name")).toContainText("Shmeisani Corner Store", {
      timeout: 15_000,
    });
    // Its own catalogue, not the pilot's 20.
    await expect(page.getByTestId("product-item").first()).toBeVisible();
    await expect(page.getByTestId("product-item")).toHaveCount(8);

    // Back returns to the list.
    await page.getByTestId("back-to-shops").click();
    await expect(
      page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }),
    ).toBeVisible();
  });
});
