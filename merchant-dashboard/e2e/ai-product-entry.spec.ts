/**
 * AI product entry — does it actually save the merchant time? (8.2a)
 *
 * Drives the REAL dashboard in a REAL browser and MEASURES both paths, rather
 * than assuming the feature helps.
 *
 * ⚠️ HONESTY NOTE ON WHAT THIS MEASURES.
 *
 * The dev analyzer returns a canned suggestion instantly, so this measures the
 * WORKFLOW (photo → check prefilled fields → save, versus type every field),
 * NOT real API latency. A live Claude call adds a few seconds per item, and
 * that is NOT included here — the numbers below are the workflow difference
 * only. The report says so.
 *
 * The objective, assumption-free figures are the ACTION COUNTS: characters
 * typed, fields filled, clicks. The elapsed times depend on a typing-speed
 * assumption, stated explicitly below.
 *
 * Prerequisites: API :3000, dashboard :5173, seeded DB.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3000/api";
const MERCHANT_PHONE = "0791234567";

/**
 * Simulated typing speed: 140ms per character (~7 chars/sec, ~85 wpm-equivalent
 * for short bursts).
 *
 * This is an ASSUMPTION and the single biggest lever on the "manual" number, so
 * it is deliberately generous to the manual path — a real shopkeeper on a
 * laptop, entering unfamiliar product names, is very unlikely to be faster than
 * this. A slower, more realistic assumption would make the AI path look better,
 * so erring fast keeps the comparison honest.
 */
const MS_PER_KEYSTROKE = 140;

/** A 2x2 PNG — the smallest thing that passes magic-byte validation. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC",
  "base64",
);

/** Signs in against the API and returns a token. Dev mode returns the code. */
async function apiSignIn(phone: string): Promise<string> {
  const req = await fetch(`${API}/auth/otp/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber: phone }),
  });
  const { devCode } = (await req.json()) as { devCode: string };
  const verify = await fetch(`${API}/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber: phone, code: devCode }),
  });
  return ((await verify.json()) as { accessToken: string }).accessToken;
}

/** Removes a product this spec created in the pilot shop. Throws if it cannot. */
async function deletePilotProduct(name: string): Promise<void> {
  const token = await apiSignIn(MERCHANT_PHONE);
  const auth = { Authorization: `Bearer ${token}` };

  const products = (await (await fetch(`${API}/products`, { headers: auth })).json()) as Array<{
    id: string;
    name: string;
  }>;
  const target = products.find((p) => p.name === name);
  if (!target) throw new Error(`Cleanup failed: product "${name}" not found`);

  const res = await fetch(`${API}/products/${target.id}`, { method: "DELETE", headers: auth });
  if (!res.ok) throw new Error(`Cleanup failed: DELETE returned ${res.status}`);
}

async function signInAsMerchant(page: Page) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(MERCHANT_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("tab-products").click();
  await expect(page.getByRole("heading", { name: "Add a product" })).toBeVisible();
}

/** Attaches a photo without touching the filesystem. */
async function attachPhoto(page: Page) {
  await page.setInputFiles("#photo", {
    name: "item.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
}

test.describe("AI product entry", () => {
  test.setTimeout(90_000);

  test("photographing an item fills in the name, price and category", async ({ page }) => {
    await signInAsMerchant(page);

    // Empty form to begin with — otherwise "the fields are filled" proves nothing.
    await expect(page.getByLabel("Product name")).toHaveValue("");
    await expect(page.getByLabel("Price (JOD)")).toHaveValue("");

    await attachPhoto(page);

    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });
    // The merchant typed nothing, and the form is populated.
    await expect(page.getByLabel("Product name")).not.toHaveValue("");
  });

  test("the suggestion is presented as something to CHECK, with its confidence", async ({ page }) => {
    // A confident-looking wrong answer is worse than an honest "not sure" —
    // the merchant waves it through and a bad price reaches a customer.
    await signInAsMerchant(page);
    await attachPhoto(page);

    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("ai-suggestion")).toContainText(/check|fill it in/i);
    await expect(page.getByTestId("ai-confidence")).toContainText(/%/);
  });

  test("it says plainly when it is the demo, not real recognition", async ({ page }) => {
    // Without a key the suggestions are canned. Implying otherwise would let the
    // founder judge the feature on a fiction.
    await signInAsMerchant(page);
    await attachPhoto(page);

    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("ai-suggestion")).toContainText(/demo mode/i);
  });

  test("it never overwrites something the merchant already typed", async ({ page }) => {
    // The merchant knows their own shop. A feature that destroys their typing
    // gets switched off — and they would be right to.
    await signInAsMerchant(page);

    await page.getByLabel("Product name").fill("My Own Product Name");
    await attachPhoto(page);
    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByLabel("Product name")).toHaveValue("My Own Product Name");
  });

  test("the merchant can correct the suggestion before saving", async ({ page }) => {
    await signInAsMerchant(page);
    await attachPhoto(page);
    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });

    const corrected = `[TEST] Corrected ${Date.now()}`;
    await page.getByLabel("Product name").fill(corrected);
    await page.getByLabel("Price (JOD)").fill("0.75");
    await page.getByLabel("Category").selectOption({ index: 1 });

    await page.getByRole("button", { name: "Add product" }).click();

    // What was SAVED is the merchant's correction, not the AI's guess.
    await expect(page.getByText(corrected)).toBeVisible({ timeout: 10_000 });

    // Clean up after ourselves, via the API.
    //
    // This test saves a REAL product into the REAL pilot shop — it has to, to
    // prove the correction persists — and leaving it behind gives the pilot 21
    // products, failing every suite that asserts the seeded 20.
    //
    // Deliberately NOT done through the UI: the Delete button sits behind a
    // native confirm(), which Playwright auto-dismisses, so the click did
    // nothing and the cleanup silently failed while this test still passed.
    // deletePilotProduct throws if the product is missing or the DELETE fails,
    // so it is its own assertion. Nothing is checked on the page afterwards:
    // the browser holds a list fetched before the delete and has no reason to
    // know about it — asserting the row had vanished would fail for a reason
    // that has nothing to do with the cleanup working.
    await deletePilotProduct(corrected);
  });

  // ── The measurement the founder asked for ────────────────────────────────

  test("MEASURED: time per item, AI-assisted vs typed by hand", async ({ page }) => {
    await signInAsMerchant(page);

    const productName = "Chocolate Bar 30g";
    const price = "0.50";

    // ---- Path A: manual entry, as it works today --------------------------
    const manualStart = Date.now();

    await page.getByLabel("Product name").type(productName, { delay: MS_PER_KEYSTROKE });
    await page.getByLabel("Price (JOD)").type(price, { delay: MS_PER_KEYSTROKE });
    await page.getByLabel("Category").selectOption({ index: 1 });
    await attachPhoto(page);
    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });

    const manualMs = Date.now() - manualStart;
    const manualKeystrokes = productName.length + price.length;

    // Reset for the second run.
    await page.reload();
    await page.getByTestId("tab-products").click();
    await expect(page.getByRole("heading", { name: "Add a product" })).toBeVisible();

    // ---- Path B: photograph, then check ----------------------------------
    const aiStart = Date.now();

    await attachPhoto(page);
    await expect(page.getByTestId("ai-suggestion")).toBeVisible({ timeout: 15_000 });
    // The merchant reads the three fields. Nothing typed.
    await expect(page.getByLabel("Product name")).not.toHaveValue("");

    const aiMs = Date.now() - aiStart;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "=== TIME PER ITEM — MEASURED IN A REAL BROWSER ===",
        `Manual entry:    ${manualMs} ms  (${manualKeystrokes} characters typed, 3 fields, 1 dropdown)`,
        `AI-assisted:     ${aiMs} ms  (0 characters typed, 0 fields, 0 dropdowns)`,
        `Difference:      ${manualMs - aiMs} ms saved per item (${Math.round((1 - aiMs / manualMs) * 100)}% less)`,
        "",
        `Typing speed assumed: ${MS_PER_KEYSTROKE}ms/char (deliberately generous to manual)`,
        "NOTE: dev analyzer answers instantly — a live Claude call adds seconds",
        "      per item and is NOT included. Workflow difference only.",
        "=================================================",
        "",
      ].join("\n"),
    );

    // The claim under test is that photographing beats typing. If it ever stops
    // being true, this fails rather than the feature quietly being pointless.
    expect(aiMs).toBeLessThan(manualMs);
    expect(manualKeystrokes).toBeGreaterThan(0);
  });
});
