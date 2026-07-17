/**
 * Browser tests for the merchant dashboard.
 *
 * These drive the real UI in a real browser — clicking, typing, uploading —
 * against the real API and database. Nothing here calls the API directly, so a
 * passing run proves a shopkeeper can actually do this work through the screen.
 *
 * Prerequisites: the API (port 3000) and the dashboard dev server (port 5173)
 * must both be running, and the database seeded.
 *
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A unique Jordanian mobile per run, so repeat runs never collide. */
function uniquePhone(): string {
  return `079${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
}

/**
 * Every shop these tests create is name-prefixed so it can be told apart from
 * real data. `npm run db:clean-test-data` in backend/ removes them.
 */
const TEST_SHOP_PREFIX = "[TEST] ";

/** The 20 products a real half-dinar shop would stock. */
const CATALOGUE = [
  { name: "Dish Sponge (2 pcs)", price: "0.50", category: "Household > Cleaning Supplies" },
  { name: "Scouring Pad", price: "0.35", category: "Household > Cleaning Supplies" },
  { name: "Laundry Soap Bar", price: "0.45", category: "Household > Cleaning Supplies" },
  { name: "Plastic Food Container 500ml", price: "0.50", category: "Household > Kitchen" },
  { name: "Wooden Spoon", price: "0.50", category: "Household > Kitchen" },
  { name: "Aluminium Foil Roll", price: "0.90", category: "Household > Kitchen" },
  { name: "Wafer Biscuit Bar", price: "0.25", category: "Food & Snacks > Biscuits & Sweets" },
  { name: "Chocolate Bar 30g", price: "0.50", category: "Food & Snacks > Biscuits & Sweets" },
  { name: "Salted Crackers Pack", price: "0.50", category: "Food & Snacks > Biscuits & Sweets" },
  { name: "Mineral Water 600ml", price: "0.35", category: "Food & Snacks > Drinks" },
  { name: "Orange Juice Box 250ml", price: "0.50", category: "Food & Snacks > Drinks" },
  { name: "Bar Soap 100g", price: "0.50", category: "Personal Care" },
  { name: "Toothbrush", price: "0.50", category: "Personal Care" },
  { name: "Paper Tissues Pack", price: "0.25", category: "Personal Care" },
  { name: "Ballpoint Pen (Blue)", price: "0.20", category: "Stationery" },
  { name: "A5 Notebook 40 pages", price: "0.50", category: "Stationery" },
  { name: "Pencil Eraser", price: "0.15", category: "Stationery" },
  { name: "Wooden Ruler 30cm", price: "0.50", category: "Stationery" },
  { name: "Sticky Notes Pad", price: "0.40", category: "Stationery" },
  { name: "Correction Pen", price: "0.75", category: "Stationery" },
];

/** Registers a shop and signs in, entirely through the UI. */
async function registerAndSignIn(page: Page, shopName: string): Promise<string> {
  const phone = uniquePhone();

  await page.goto("/");

  await page.getByRole("button", { name: "New shop? Register here" }).click();
  await page.getByLabel("Shop name").fill(`${TEST_SHOP_PREFIX}${shopName}`);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Register shop" }).click();

  await expect(page.getByText("Shop registered. Now sign in")).toBeVisible();

  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send login code" }).click();

  // Development mode prefills the code; a real SMS arrives in Phase 3.
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();

  // The dashboard opens on Orders (a shopkeeper's main job); these tests are
  // about product management, so switch to that tab.
  await page.getByTestId("tab-products").click();
  await expect(page.getByRole("heading", { name: "Add a product" })).toBeVisible();
  return phone;
}

/** Fills the add-product form and submits it. */
async function addProduct(
  page: Page,
  product: { name: string; price: string; category: string },
) {
  await page.getByLabel("Product name").fill(product.name);
  await page.getByLabel("Price (JOD)").fill(product.price);
  await page.getByLabel("Category").selectOption({ label: product.category });
  await page.getByRole("button", { name: "Add product" }).click();

  // The form clears only after the server confirms the write.
  await expect(page.getByLabel("Product name")).toHaveValue("", { timeout: 10_000 });
}

test.describe("Merchant dashboard", () => {
  test("a shopkeeper can register, sign in, and stock 20 products through the UI", async ({
    page,
  }) => {
    await registerAndSignIn(page, "Playwright Pilot Shop");

    // A new shop starts empty and awaiting approval.
    await expect(page.getByText("Your shop is awaiting admin approval")).toBeVisible();
    await expect(page.getByText("No products yet. Add your first one above.")).toBeVisible();

    for (const product of CATALOGUE) {
      await addProduct(page, product);
    }

    await expect(page.getByRole("heading", { name: `Your products (${CATALOGUE.length})` })).toBeVisible();
    await expect(page.getByTestId("product-row")).toHaveCount(CATALOGUE.length);

    // Spot-check that prices display exactly, not as 0.5 or 0.4999.
    const row = page.getByTestId("product-row").filter({ hasText: "Dish Sponge (2 pcs)" });
    await expect(row).toContainText("0.50 JOD");
    await expect(row).toContainText("Household > Cleaning Supplies");

    await page.screenshot({ path: "e2e/screenshots/dashboard-20-products.png", fullPage: true });
  });

  test("products survive a full page reload (they are really in the database)", async ({ page }) => {
    await registerAndSignIn(page, "Persistence Shop");

    await addProduct(page, { name: "Persisted Item", price: "0.50", category: "Personal Care" });
    await expect(page.getByTestId("product-row")).toHaveCount(1);

    await page.reload();
    await page.getByTestId("tab-products").click();

    // Re-fetched from the API after a reload — nothing is held in browser state.
    await expect(page.getByTestId("product-row")).toHaveCount(1);
    await expect(page.getByText("Persisted Item")).toBeVisible();
  });

  test("a shopkeeper can edit a product's name and price", async ({ page }) => {
    await registerAndSignIn(page, "Edit Shop");
    await addProduct(page, { name: "Original Name", price: "0.50", category: "Stationery" });

    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Product name").fill("Corrected Name");
    await page.getByLabel("Price (JOD)").fill("0.75");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText("Corrected Name")).toBeVisible();
    await expect(page.getByText("Original Name")).toHaveCount(0);
    await expect(page.getByTestId("product-row")).toContainText("0.75 JOD");
  });

  test("a shopkeeper can mark an item out of stock and back in", async ({ page }) => {
    await registerAndSignIn(page, "Stock Shop");
    await addProduct(page, { name: "Stock Item", price: "0.50", category: "Personal Care" });

    const toggle = page.getByRole("button", { name: /Toggle availability/ });
    await expect(toggle).toHaveText("In stock");

    await toggle.click();
    await expect(toggle).toHaveText("Out of stock");

    // The change must survive a reload, not just flip in the browser.
    await page.reload();
    await page.getByTestId("tab-products").click();
    await expect(page.getByRole("button", { name: /Toggle availability/ })).toHaveText("Out of stock");

    await page.getByRole("button", { name: /Toggle availability/ }).click();
    await expect(page.getByRole("button", { name: /Toggle availability/ })).toHaveText("In stock");
  });

  test("a shopkeeper can delete a product", async ({ page }) => {
    await registerAndSignIn(page, "Delete Shop");
    await addProduct(page, { name: "Doomed Item", price: "0.50", category: "Stationery" });

    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("No products yet. Add your first one above.")).toBeVisible();
  });

  test("a shopkeeper can upload a product photo", async ({ page }) => {
    await registerAndSignIn(page, "Photo Shop");

    // A real 2x2 PNG written to disk, then chosen via the file picker.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC",
      "base64",
    );
    const path = join(tmpdir(), "halfdinar-test-photo.png");
    writeFileSync(path, png);

    await page.getByLabel("Product name").fill("Item With Photo");
    await page.getByLabel("Price (JOD)").fill("0.50");
    await page.getByLabel("Category").selectOption({ label: "Personal Care" });
    // Label renamed in Phase 8 ("Photo (optional)" -> "Photo — we'll fill in
    // the rest") when photographing an item started filling the form in.
    await page.getByLabel(/^Photo/).setInputFiles(path);

    // The photo now also triggers an AI suggestion, so "attached ✓" appears
    // once BOTH the upload and the read have finished.
    await expect(page.getByTestId("upload-ok")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Add product" }).click();

    // The thumbnail must actually load — a broken URL would leave width 0.
    const thumb = page.getByTestId("product-row").locator("img.thumb");
    await expect(thumb).toBeVisible();
    const width = await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth);
    expect(width).toBeGreaterThan(0);
  });

  test("the search box filters the product list", async ({ page }) => {
    await registerAndSignIn(page, "Search Shop");
    await addProduct(page, { name: "Findable Widget", price: "0.50", category: "Stationery" });
    await addProduct(page, { name: "Hidden Gadget", price: "0.50", category: "Stationery" });

    await page.getByLabel("Search products").fill("findable");

    await expect(page.getByTestId("product-row")).toHaveCount(1);
    await expect(page.getByText("Findable Widget")).toBeVisible();
  });

  test("the UI surfaces a server validation error instead of failing silently", async ({ page }) => {
    await registerAndSignIn(page, "Validation Shop");

    // An over-long name: the form has no client-side length cap, so this reaches
    // the server, is rejected there, and the UI must show why. (Negative prices
    // are blocked by the input's own min="0" before a request is ever made, so
    // they cannot be used to test the server round-trip from here — the API
    // tests cover that rejection directly.)
    await page.getByLabel("Product name").fill("X".repeat(200));
    await page.getByLabel("Price (JOD)").fill("0.50");
    await page.getByLabel("Category").selectOption({ label: "Stationery" });
    await page.getByRole("button", { name: "Add product" }).click();

    await expect(page.getByTestId("error")).toContainText("name must be between 2 and 160");
    await expect(page.getByTestId("product-row")).toHaveCount(0);
  });

  test("the price field blocks a negative value before it can be submitted", async ({ page }) => {
    await registerAndSignIn(page, "Negative Price Shop");

    await page.getByLabel("Product name").fill("Negative Price Item");
    await page.getByLabel("Price (JOD)").fill("-5");
    await page.getByLabel("Category").selectOption({ label: "Stationery" });
    await page.getByRole("button", { name: "Add product" }).click();

    // The browser's own constraint validation refuses to submit the form.
    const valid = await page
      .locator("#price")
      .evaluate((el: HTMLInputElement) => el.checkValidity());
    expect(valid).toBe(false);
    await expect(page.getByTestId("product-row")).toHaveCount(0);
  });
});
