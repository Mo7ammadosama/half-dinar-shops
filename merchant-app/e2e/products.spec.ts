/**
 * Merchant product management, driven through the real app UI.
 *
 * Add a product, see it in the list, edit its price, toggle availability, then
 * delete it — proving the whole product CRUD loop works from the phone app.
 *
 * The camera / AI-photo entry is NOT exercised here: it needs a real camera and
 * a device, so it is verified separately (device-unproven, like B5) rather than
 * faked on the web target. This suite covers everything else.
 *
 * Products created here have a "[E2E] " name prefix and are deleted at the end
 * of each test, so they never linger in the dev database.
 */
import { expect, test, type Page } from "@playwright/test";

const SEEDED_MERCHANT = "0791234567";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("phone-input").fill(SEEDED_MERCHANT);
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("merchant-header")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tab-products").click();
}

test.describe("Merchant products", () => {
  test("add a product, edit its price, toggle stock, then delete it", async ({ page }) => {
    await signIn(page);

    const name = `[E2E] Widget ${Date.now()}`;

    // --- Add ---
    await page.getByTestId("product-name").fill(name);
    await page.getByTestId("product-price").fill("0.55");
    await page.getByTestId("category-picker").click();
    // Pick any real category by its path text.
    await page.getByText("Stationery", { exact: false }).first().click();
    await page.getByTestId("save-product").click();

    const row = page.getByTestId("product-row").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("0.55 JOD");

    // --- Edit price ---
    await row.getByRole("button", { name: "Edit" }).or(row.locator("text=Edit")).first().click();
    await expect(page.getByTestId("product-price")).toHaveValue("0.55");
    await page.getByTestId("product-price").fill("0.99");
    await page.getByTestId("save-product").click();
    await expect(
      page.getByTestId("product-row").filter({ hasText: name }),
    ).toContainText("0.99 JOD", { timeout: 15_000 });

    // --- Toggle availability ---
    const row2 = page.getByTestId("product-row").filter({ hasText: name });
    await expect(row2).toContainText("In stock");
    await row2.getByText("In stock").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toContainText(
      "Out of stock",
      { timeout: 15_000 },
    );

    // --- Delete (now a two-step confirm — a careless tap used to destroy a product) ---
    const rowToDelete = page.getByTestId("product-row").filter({ hasText: name });
    await rowToDelete.getByText("Delete", { exact: true }).click();
    // The inline confirmation appears in place of Edit/Delete.
    await rowToDelete.getByText("Yes, delete").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test("search narrows the product list", async ({ page }) => {
    await signIn(page);
    // The seeded catalogue has a Toothbrush and nothing matching 'helicopter'.
    await page.getByTestId("product-search").fill("Toothbrush");
    await expect(page.getByTestId("product-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("product-row")).toContainText("Toothbrush");

    await page.getByTestId("product-search").fill("helicopter");
    await expect(page.getByTestId("no-products")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("product-search").fill("");
    await expect(page.getByTestId("product-row").first()).toBeVisible({ timeout: 15_000 });
  });

  test("adding without a category is refused (server-validated)", async ({ page }) => {
    await signIn(page);
    await page.getByTestId("product-name").fill(`[E2E] NoCat ${Date.now()}`);
    await page.getByTestId("product-price").fill("0.50");
    // No category chosen.
    await page.getByTestId("save-product").click();
    await expect(page.getByTestId("products-error")).toBeVisible({ timeout: 15_000 });
  });

  test("out-of-stock warning banner + availability filter", async ({ page }) => {
    await signIn(page);
    const name = `[E2E] Stock ${Date.now()}`;

    // Add a product (starts in stock), then mark it out of stock.
    await page.getByTestId("product-name").fill(name);
    await page.getByTestId("product-price").fill("0.50");
    await page.getByTestId("category-picker").click();
    await page.getByText("Stationery", { exact: false }).first().click();
    await page.getByTestId("save-product").click();

    const row = page.getByTestId("product-row").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByText("In stock").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toContainText(
      "Out of stock",
      { timeout: 15_000 },
    );

    // The warning banner now reports at least one out-of-stock product.
    await expect(page.getByTestId("stock-warning")).toBeVisible();

    // Filtering to "Out of stock" keeps our product; "In stock" hides it.
    await page.getByTestId("prodfilter-out").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toBeVisible();
    await page.getByTestId("prodfilter-in").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0);

    // Back to all, then clean up through the confirm step.
    await page.getByTestId("prodfilter-all").click();
    const row2 = page.getByTestId("product-row").filter({ hasText: name });
    await row2.getByText("Delete", { exact: true }).click();
    await row2.getByText("Yes, delete").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test("Undo on the availability toggle restores the previous stock state", async ({ page }) => {
    await signIn(page);
    const name = `[E2E] Undo ${Date.now()}`;

    await page.getByTestId("product-name").fill(name);
    await page.getByTestId("product-price").fill("0.50");
    await page.getByTestId("category-picker").click();
    await page.getByText("Stationery", { exact: false }).first().click();
    await page.getByTestId("save-product").click();

    const row = page.getByTestId("product-row").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("In stock");

    // Toggle it out of stock, then Undo via the toast — the pill must return to
    // "In stock" (proves the undo closure captured the RIGHT previous value).
    await row.getByText("In stock").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toContainText(
      "Out of stock",
      { timeout: 15_000 },
    );
    await page.getByTestId("toast-action").click(); // "Undo"
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toContainText(
      "In stock",
      { timeout: 15_000 },
    );

    // Cleanup.
    const row2 = page.getByTestId("product-row").filter({ hasText: name });
    await row2.getByText("Delete", { exact: true }).click();
    await row2.getByText("Yes, delete").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test("sort by price and by name reorders the list", async ({ page }) => {
    await signIn(page);
    const token = `Zsort${Date.now()}`;
    const cheap = `[E2E] ${token} aaa`; // alphabetically first, cheapest
    const dear = `[E2E] ${token} zzz`; // alphabetically last, dearest

    for (const [n, price] of [
      [dear, "9.90"],
      [cheap, "0.10"],
    ] as const) {
      await page.getByTestId("product-name").fill(n);
      await page.getByTestId("product-price").fill(price);
      await page.getByTestId("category-picker").click();
      await page.getByText("Stationery", { exact: false }).first().click();
      await page.getByTestId("save-product").click();
      await expect(page.getByTestId("product-row").filter({ hasText: n })).toBeVisible({
        timeout: 15_000,
      });
    }

    // Isolate the two products by the shared unique token.
    await page.getByTestId("product-search").fill(token);
    await expect(page.getByTestId("product-row")).toHaveCount(2, { timeout: 15_000 });

    // Sort by price → cheapest first.
    await page.getByTestId("prodsort-price").click();
    await expect(page.getByTestId("product-row").first()).toContainText("aaa");

    // Sort by name → alphabetically first ("aaa") first.
    await page.getByTestId("prodsort-name").click();
    await expect(page.getByTestId("product-row").first()).toContainText("aaa");

    // Cleanup both.
    for (const n of [cheap, dear]) {
      const r = page.getByTestId("product-row").filter({ hasText: n });
      await r.getByText("Delete", { exact: true }).click();
      await r.getByText("Yes, delete").click();
      await expect(page.getByTestId("product-row").filter({ hasText: n })).toHaveCount(0, {
        timeout: 15_000,
      });
    }
  });

  test("Delete asks for confirmation and 'Keep' aborts it", async ({ page }) => {
    await signIn(page);
    // Name deliberately avoids the words "Keep"/"Delete" so text locators below
    // match the buttons, not the product name.
    const name = `[E2E] Sponge ${Date.now()}`;

    await page.getByTestId("product-name").fill(name);
    await page.getByTestId("product-price").fill("0.50");
    await page.getByTestId("category-picker").click();
    await page.getByText("Stationery", { exact: false }).first().click();
    await page.getByTestId("save-product").click();

    const row = page.getByTestId("product-row").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Tap Delete → confirmation appears → tap Keep → product survives.
    await row.getByText("Delete", { exact: true }).click();
    await expect(row.getByText("Delete this?")).toBeVisible();
    await row.getByText("Keep", { exact: true }).click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toBeVisible();

    // Now really delete it (cleanup).
    await row.getByText("Delete", { exact: true }).click();
    await row.getByText("Yes, delete").click();
    await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
