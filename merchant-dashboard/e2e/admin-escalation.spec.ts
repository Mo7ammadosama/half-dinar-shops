/**
 * The admin escalation queue — the last line of defence for a missed order.
 *
 * Drives the REAL admin panel in a REAL browser against the REAL API.
 *
 * Prerequisites: API on :3000 started with SHORT escalation windows, so a test
 * does not wait minutes for a real one:
 *
 *   ESCALATION_FIRST_ALERT_SECONDS=2 ESCALATION_ADMIN_ALERT_SECONDS=4 \
 *     RATE_LIMIT_OTP_PER_MIN=500 ... node dist/src/main
 *
 * Run with: npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";
import { forceEnglish } from "./lang";

const API = "http://localhost:3000/api";
const ADMIN_PHONE = "0799999999";
const MERCHANT_PHONE = "0791234567";
const CUSTOMER_PHONE = `078000${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`;

/** How long the API was told to wait before involving the admin. */
const ADMIN_ALERT_SECONDS = Number(process.env.ESCALATION_ADMIN_ALERT_SECONDS ?? 4);

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
  const { accessToken } = (await verify.json()) as { accessToken: string };
  return accessToken;
}

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
  const product = products.find((p) => p.isAvailable)!;

  const order = (await (
    await fetch(`${API}/orders`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ shopId: pilot.id, items: [{ productId: product.id, quantity: 1 }] }),
    })
  ).json()) as { id: string };
  return order.id;
}

async function confirmAllPending() {
  const token = await apiSignIn(MERCHANT_PHONE);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const orders = (await (
    await fetch(`${API}/merchant/orders?status=PENDING`, { headers: auth })
  ).json()) as Array<{ id: string }>;
  for (const o of orders) {
    await fetch(`${API}/merchant/orders/${o.id}/confirm`, { method: "POST", headers: auth });
  }
}

async function signInAsAdmin(page: Page) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(ADMIN_PHONE);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("admin-tab-merchants")).toBeVisible();
}

test.describe("Admin escalation queue", () => {
  // The admin screen refreshes on a 20s poll, and these tests deliberately wait
  // for it rather than reloading — "the admin notices without going looking" is
  // the property under test, and a reload would fake it.
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => forceEnglish(page));

  test.beforeEach(async () => {
    await confirmAllPending();
  });

  test.afterEach(async () => {
    await confirmAllPending();
  });

  test("an ignored order reaches the admin, with the shop's number to call", async ({ page }) => {
    await signInAsAdmin(page);

    // Nothing waiting to begin with, or "it appeared" would prove nothing.
    await page.getByTestId("admin-tab-ignored").click();
    await expect(page.getByTestId("admin-ignored-empty")).toBeVisible();

    await placeRealOrder();
    // Nobody at the shop touches it. This is the whole scenario.
    await page.waitForTimeout((ADMIN_ALERT_SECONDS + 1) * 1000);

    await expect(page.getByTestId("admin-ignored-row")).toBeVisible({ timeout: 70_000 });
    // The admin's actual job: phone the shop.
    await expect(page.getByTestId("admin-ignored-shop-phone")).toHaveText("+962791234567");
  });

  test("the badge is visible from another section, without going looking", async ({ page }) => {
    // An alert you have to click a tab to discover is not an alert.
    await signInAsAdmin(page);
    await placeRealOrder();
    await page.waitForTimeout((ADMIN_ALERT_SECONDS + 1) * 1000);

    // Sitting on Shops, not the escalation queue.
    await page.getByTestId("admin-tab-merchants").click();

    await expect(page.getByTestId("admin-ignored-badge")).toBeVisible({ timeout: 70_000 });
    await expect(page.getByTestId("admin-ignored-badge")).toHaveText("1");
  });

  test("an order the shop confirms never reaches the admin", async ({ page }) => {
    // The shop doing its job must not generate an incident.
    await signInAsAdmin(page);

    await placeRealOrder();
    await confirmAllPending(); // The shopkeeper responds immediately.
    await page.waitForTimeout((ADMIN_ALERT_SECONDS + 1) * 1000);

    await page.getByTestId("admin-tab-ignored").click();
    await expect(page.getByTestId("admin-ignored-empty")).toBeVisible();
  });
});
