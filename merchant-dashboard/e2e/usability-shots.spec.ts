/**
 * Usability walk-through (8.3) — screenshots, not assertions.
 *
 * This project's own history is that a green tick proves nothing about whether
 * a screen makes sense: the admin Overview once read "0 orders" directly above
 * a table listing a delivered one, and every test passed. So this captures the
 * screens for a human (me) to LOOK at.
 *
 * Not part of the normal suite — run explicitly.
 */
import { test, type Page } from "@playwright/test";

const API = "http://localhost:3000/api";
const SHOTS = "e2e/screenshots";

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

/** A real pending order, so the merchant screens have something to show. */
async function placeOrder(): Promise<void> {
  const token = await apiSignIn(`078000${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const shops = (await (await fetch(`${API}/shops`, { headers: auth })).json()) as Array<{
    id: string;
    shopName: string;
  }>;
  const pilot = shops.find((s) => s.shopName === "Al-Nus Dinar Shop")!;
  const products = (await (
    await fetch(`${API}/shops/${pilot.id}/products`, { headers: auth })
  ).json()) as Array<{ id: string; isAvailable: boolean }>;

  await fetch(`${API}/orders`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      shopId: pilot.id,
      items: [{ productId: products.find((p) => p.isAvailable)!.id, quantity: 2 }],
    }),
  });
}

async function signIn(page: Page, phone: string) {
  await page.goto("/");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send login code" }).click();
  await page.getByText(/Development mode: your code is/).waitFor();
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Usability walk-through", () => {
  test.setTimeout(60_000);

  test("merchant: the screen when an order is waiting", async ({ page }) => {
    await placeOrder();
    await signIn(page, "0791234567");
    await page.getByTestId("new-order-alert").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ux-merchant-new-order.png`, fullPage: true });
  });

  test("merchant: the add-product screen with an AI suggestion", async ({ page }) => {
    await signIn(page, "0791234567");
    await page.getByTestId("tab-products").click();
    await page.setInputFiles("#photo", {
      name: "item.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC",
        "base64",
      ),
    });
    await page.getByTestId("ai-suggestion").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ux-merchant-ai-entry.png`, fullPage: true });
  });

  test("admin: the overview", async ({ page }) => {
    await signIn(page, "0799999999");
    await page.getByTestId("admin-tab-merchants").waitFor();
    await page.screenshot({ path: `${SHOTS}/ux-admin-overview.png`, fullPage: true });
  });

  test("admin: the escalation queue", async ({ page }) => {
    await signIn(page, "0799999999");
    await page.getByTestId("admin-tab-ignored").click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/ux-admin-ignored.png`, fullPage: true });
  });
});
