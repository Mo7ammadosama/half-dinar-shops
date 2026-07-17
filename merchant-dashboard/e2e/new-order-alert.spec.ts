/**
 * The new-order alert — the single most important reliability point.
 *
 * If the shop misses an order, the customer waits for something that is never
 * coming and nothing tells them why. This drives the REAL dashboard in a REAL
 * browser and places a REAL order through the API, then checks the shopkeeper
 * is genuinely alerted.
 *
 * Prerequisites: API on :3000, dashboard on :5173, database seeded.
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3000/api";

/** The seeded pilot shop's owner. */
const MERCHANT_PHONE = "0791234567";
/** Reserved test-customer range — db:clean-test-data removes these. */
const CUSTOMER_PHONE = `078000${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`;

/** Signs in against the API and returns a token. Dev mode returns the code. */
async function apiSignIn(phone: string): Promise<string> {
  const reqRes = await fetch(`${API}/auth/otp/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber: phone }),
  });
  const { devCode } = (await reqRes.json()) as { devCode: string };

  const verifyRes = await fetch(`${API}/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber: phone, code: devCode }),
  });
  const { accessToken } = (await verifyRes.json()) as { accessToken: string };
  return accessToken;
}

/** Places a genuine order at the pilot shop, as a customer would. */
async function placeRealOrder(): Promise<string> {
  const token = await apiSignIn(CUSTOMER_PHONE);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const shops = (await (await fetch(`${API}/shops`, { headers: auth })).json()) as Array<{
    id: string;
    shopName: string;
  }>;
  const pilot = shops.find((s) => s.shopName === "Al-Nus Dinar Shop");
  if (!pilot) throw new Error("Pilot shop not found — is the database seeded?");

  const products = (await (
    await fetch(`${API}/shops/${pilot.id}/products`, { headers: auth })
  ).json()) as Array<{ id: string; isAvailable: boolean }>;
  const product = products.find((p) => p.isAvailable);
  if (!product) throw new Error("No available product in the pilot shop.");

  const order = (await (
    await fetch(`${API}/orders`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ shopId: pilot.id, items: [{ productId: product.id, quantity: 1 }] }),
    })
  ).json()) as { id: string };

  return order.id;
}

/** Signs the merchant into the dashboard UI. */
async function signInAsMerchant(page: Page) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(MERCHANT_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("tab-orders")).toBeVisible();
}

/** Clears any pending orders so a test starts from a quiet dashboard. */
async function confirmAllPending() {
  const token = await apiSignIn(MERCHANT_PHONE);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const orders = (await (
    await fetch(`${API}/merchant/orders?status=PENDING`, { headers: auth })
  ).json()) as Array<{ id: string }>;

  for (const order of orders) {
    await fetch(`${API}/merchant/orders/${order.id}/confirm`, { method: "POST", headers: auth });
  }
}

test.describe("New-order alert", () => {
  test.beforeEach(async () => {
    await confirmAllPending();
  });

  test("a real order raises an unmissable alert on the shopkeeper's screen", async ({ page }) => {
    await signInAsMerchant(page);

    // Quiet to begin with — otherwise "the alert appeared" proves nothing.
    await expect(page.getByTestId("new-order-alert")).toBeHidden();

    await placeRealOrder();

    // No reload, no click: the dashboard must notice by itself.
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("new-order-alert-title")).toContainText("1 new order");
  });

  test("the alert arrives promptly, not on the next 10-second poll", async ({ page }) => {
    await signInAsMerchant(page);
    await expect(page.getByTestId("new-order-alert")).toBeHidden();

    const placedAt = Date.now();
    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });
    const elapsed = Date.now() - placedAt;

    // The poll alone would average ~5s and could take 10s. The live stream
    // should beat that comfortably. Generous bound: this asserts "pushed, not
    // polled" without being a stopwatch that fails on a slow CI box.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("the tab title changes, so it is visible from a background tab", async ({ page }) => {
    // The dashboard will usually be behind whatever else the shop is doing.
    await signInAsMerchant(page);
    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });

    // The title alternates, so poll for the badge rather than reading once.
    await expect(async () => {
      expect(await page.title()).toMatch(/NEW ORDER/);
    }).toPass({ timeout: 5_000 });
  });

  test("the alarm actually plays audio — not merely a silent badge", async ({ page }) => {
    // The point of the alarm is the sound. A test that only checked the banner
    // would pass with the audio completely broken.
    await signInAsMerchant(page);

    // Count real oscillator starts by instrumenting the Web Audio API.
    await page.evaluate(() => {
      const w = window as unknown as { __beeps: number };
      w.__beeps = 0;
      const original = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function patched(this: AudioContext) {
        w.__beeps += 1;
        return original.call(this);
      };
    });

    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });

    await expect(async () => {
      const beeps = await page.evaluate(() => (window as unknown as { __beeps: number }).__beeps);
      expect(beeps).toBeGreaterThan(0);
    }).toPass({ timeout: 8_000 });
  });

  test("the alarm REPEATS until a human acknowledges it", async ({ page }) => {
    // A single beep is missable — the shopkeeper may be at the counter. This is
    // the difference between "we played a sound" and "we got their attention".
    await signInAsMerchant(page);

    await page.evaluate(() => {
      const w = window as unknown as { __beeps: number };
      w.__beeps = 0;
      const original = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function patched(this: AudioContext) {
        w.__beeps += 1;
        return original.call(this);
      };
    });

    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });

    const first = await page.evaluate(() => (window as unknown as { __beeps: number }).__beeps);

    // Wait past one repeat interval (3s) and confirm it sounded again.
    await page.waitForTimeout(4_000);
    const second = await page.evaluate(() => (window as unknown as { __beeps: number }).__beeps);

    expect(second).toBeGreaterThan(first);
  });

  test("acknowledging silences the alarm and opens the orders tab", async ({ page }) => {
    await signInAsMerchant(page);
    await page.getByTestId("tab-products").click();

    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("new-order-alert-ack").click();

    // The banner goes, and the shopkeeper is looking at the order.
    await expect(page.getByTestId("new-order-alert")).toBeHidden();
    await expect(page.getByTestId("tab-orders")).toHaveClass(/tab-active/);
    await expect(async () => {
      expect(await page.title()).not.toMatch(/NEW ORDER/);
    }).toPass({ timeout: 4_000 });
  });

  test("the alert does NOT dismiss itself while the order is still waiting", async ({ page }) => {
    // A self-dismissing alert would quietly return the shop to exactly the
    // state this exists to prevent.
    await signInAsMerchant(page);
    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(6_000);

    await expect(page.getByTestId("new-order-alert")).toBeVisible();
  });

  test("a SECOND order re-alerts even though the first was acknowledged", async ({ page }) => {
    // The busiest moment is exactly when a naive "dismissed" flag would leave
    // the dashboard silent.
    await signInAsMerchant(page);

    await placeRealOrder();
    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("new-order-alert-ack").click();
    await expect(page.getByTestId("new-order-alert")).toBeHidden();

    await placeRealOrder();

    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("new-order-alert-title")).toContainText("1 new order");
  });

  test("the badge count still agrees with the alert", async ({ page }) => {
    await signInAsMerchant(page);
    await placeRealOrder();
    await placeRealOrder();

    await expect(page.getByTestId("new-order-alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("new-order-alert-title")).toContainText("2 new orders");
    await expect(page.getByTestId("pending-badge")).toHaveText("2");
  });
});
