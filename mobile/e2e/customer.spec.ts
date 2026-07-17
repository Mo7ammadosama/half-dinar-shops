/**
 * Customer app walkthrough.
 *
 * Drives the real Expo app in a real browser: sign in with a phone number,
 * receive a code, browse the pilot shop's shelf, filter, and search.
 *
 * TARGET: Expo's **web** target (react-native-web). These are the same React
 * Native components and the same application logic the phone runs, rendered by
 * the same Expo bundler — but it is not a native device. Native-specific
 * behaviour (real GPS prompts, the SMS autofill keyboard) still needs a check on
 * a physical phone via Expo Go.
 *
 * Prerequisites: API on :3000 (with relaxed rate limits) and `expo start --web`
 * on :8081, database seeded.
 *
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * A unique phone number from the reserved test range, so repeat runs never
 * collide and the accounts can be told apart from real customers afterwards.
 *
 * Reserved range: 0780000000–0780000999 (+962780000XXX).
 * `npm run db:clean-test-data` in backend/ deletes exactly this range.
 */
function uniquePhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

/** The seeded customer account. */
const SEEDED_CUSTOMER = "0791111111";

/** Signs in through the UI and lands on the shop LIST (the new landing screen). */
async function signInToList(page: Page, phone: string) {
  await page.goto("/");

  await page.getByTestId("phone-input").fill(phone);
  await page.getByTestId("send-code").click();

  // Development mode prefills the code (no SMS provider yet).
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();

  await expect(
    page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Opens a shop from the list into its storefront. */
async function enterShop(page: Page, shopName: string) {
  await page.getByTestId("shop-card").filter({ hasText: shopName }).click();
  await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 15_000 });
}

/** Signs in and opens the pilot shop — the common path for the browse tests. */
async function signIn(page: Page, phone: string) {
  await signInToList(page, phone);
  await enterShop(page, "Al-Nus Dinar Shop");
}

test.describe("Customer app", () => {
  test("a brand-new customer can sign up with just a phone number and reach the shop", async ({
    page,
  }) => {
    // A phone number never seen before — signing in *is* registration.
    await signIn(page, uniquePhone());

    await expect(page.getByTestId("shop-name")).toHaveText("Al-Nus Dinar Shop");
    await expect(page.getByText(/Open 08:00-23:00/)).toBeVisible();
  });

  test("a wrong code is refused with a readable message", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("phone-input").fill(uniquePhone());
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });

    await page.getByTestId("code-input").fill("000000");
    await page.getByTestId("verify-code").click();

    await expect(page.getByTestId("login-error")).toContainText("Invalid or expired code");
    // And must not let them through.
    await expect(page.getByTestId("shop-name")).toHaveCount(0);
  });

  test("all 20 of the shop's products are shown with correct price and category", async ({
    page,
  }) => {
    await signIn(page, SEEDED_CUSTOMER);

    await expect(page.getByTestId("product-item")).toHaveCount(20);

    // Spot-check exact prices — 0.50 must not render as 0.5.
    const chocolate = page.getByTestId("product-item").filter({ hasText: "Chocolate Bar 30g" });
    await expect(chocolate).toContainText("0.50 JOD");
    await expect(chocolate).toContainText("Food & Snacks > Biscuits & Sweets");

    const eraser = page.getByTestId("product-item").filter({ hasText: "Pencil Eraser" });
    await expect(eraser).toContainText("0.15 JOD");
    await expect(eraser).toContainText("Stationery");

    await page.screenshot({ path: "e2e/screenshots/customer-browse.png", fullPage: true });
  });

  test("every seeded product appears with exactly the right price", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);
    await expect(page.getByTestId("product-item")).toHaveCount(20);

    // The full seeded catalogue — proves nothing is missing or mispriced,
    // rather than trusting a spot-check.
    const expected: Record<string, string> = {
      "Dish Sponge (2 pcs)": "0.50",
      "Scouring Pad": "0.35",
      "Multi-Purpose Cleaning Cloth": "0.50",
      "Rubber Gloves": "0.75",
      "Plastic Food Container 500ml": "0.50",
      "Aluminium Foil Roll": "0.90",
      "Wooden Spoon": "0.50",
      "Wafer Biscuit Bar": "0.25",
      "Chocolate Bar 30g": "0.50",
      "Salted Crackers Pack": "0.50",
      "Mineral Water 600ml": "0.35",
      "Orange Juice Box 250ml": "0.50",
      "Energy Drink 250ml": "0.75",
      "Bar Soap 100g": "0.50",
      "Toothbrush": "0.50",
      "Paper Tissues Pack": "0.25",
      "Ballpoint Pen (Blue)": "0.20",
      "A5 Notebook 40 pages": "0.50",
      "Pencil Eraser": "0.15",
      "Wooden Ruler 30cm": "0.50",
    };

    for (const [name, price] of Object.entries(expected)) {
      const row = page.getByTestId("product-item").filter({ hasText: name });
      await expect(row, `"${name}" should be listed`).toHaveCount(1);
      await expect(row, `"${name}" should cost ${price} JOD`).toContainText(`${price} JOD`);
    }
  });

  test("the out-of-stock item is shown but clearly marked", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);

    const energy = page.getByTestId("product-item").filter({ hasText: "Energy Drink 250ml" });
    // Shown, not hidden — the customer should see the real shelf.
    await expect(energy).toHaveCount(1);
    await expect(energy.getByTestId("out-of-stock")).toBeVisible();

    // Exactly one seeded product is unavailable.
    await expect(page.getByTestId("out-of-stock")).toHaveCount(1);
  });

  test("search narrows the list", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);

    await page.getByTestId("search-input").fill("juice");
    await expect(page.getByTestId("product-item")).toHaveCount(1);
    await expect(page.getByTestId("product-item")).toContainText("Orange Juice Box 250ml");

    // Clearing brings everything back.
    await page.getByTestId("search-input").fill("");
    await expect(page.getByTestId("product-item")).toHaveCount(20);
  });

  test("search that matches nothing shows a friendly empty state, not an error", async ({
    page,
  }) => {
    await signIn(page, SEEDED_CUSTOMER);

    await page.getByTestId("search-input").fill("helicopter");

    await expect(page.getByTestId("no-results")).toBeVisible();
    await expect(page.getByTestId("browse-error")).toHaveCount(0);
  });

  test("the category filter shows only that category's items", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);

    await page.getByTestId("chip-Drinks").click();

    await expect(page.getByTestId("product-item")).toHaveCount(3);
    for (const text of ["Mineral Water 600ml", "Orange Juice Box 250ml", "Energy Drink 250ml"]) {
      await expect(page.getByTestId("product-item").filter({ hasText: text })).toHaveCount(1);
    }

    // "All" restores the full list.
    await page.getByTestId("chip-all").click();
    await expect(page.getByTestId("product-item")).toHaveCount(20);
  });

  test("category filters only offer categories the shop actually stocks", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);

    // Leaf categories the pilot stocks.
    await expect(page.getByTestId("chip-Drinks")).toBeVisible();
    await expect(page.getByTestId("chip-Stationery")).toBeVisible();

    // Empty parent categories would be dead-end filters.
    await expect(page.getByTestId("chip-Household")).toHaveCount(0);
    await expect(page.getByTestId("chip-Food & Snacks")).toHaveCount(0);
  });

  test("browsing works before any location is set — location never gates the shop", async ({
    page,
  }) => {
    await signInToList(page, SEEDED_CUSTOMER);

    // No location has been granted or chosen, yet the list renders and the shop
    // opens and is fully browsable — location never gates shopping.
    await expect(page.getByTestId("place-label")).toHaveText("Set delivery location");
    await enterShop(page, "Al-Nus Dinar Shop");
    await expect(page.getByTestId("product-item")).toHaveCount(20);
  });

  test("the session survives a reload, and signing out ends it", async ({ page }) => {
    await signIn(page, SEEDED_CUSTOMER);

    // A returning customer should not have to log in again — a reload restores the
    // session and lands them back on the shop list.
    await page.reload();
    await expect(
      page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("phone-input")).toBeVisible();

    // And the session must be genuinely gone, not just visually.
    await page.reload();
    await expect(page.getByTestId("phone-input")).toBeVisible({ timeout: 15_000 });
  });
});
