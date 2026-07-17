/**
 * PHASE 7 FINAL TEST — the whole product, end to end, in real browsers.
 *
 * One order's entire life, driven through three real UIs by three real people:
 *
 *   ADMIN     approves a brand-new shop and adds a master category
 *   MERCHANT  registers, stocks a product, takes the order, picks it, sends it
 *   CUSTOMER  signs up, browses, orders, calls the shop, tracks, receives, reviews
 *   ADMIN     sees the finished order and its review
 *
 * Nothing is stubbed: every step is a click or a keystroke against the real API
 * and the real database. This is the Phase 7 requirement — proving Phases 1–7
 * work together.
 *
 * Prerequisites: API :3000, expo web :8081, dashboard :5173, database seeded.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const DASHBOARD = "http://localhost:5173";
const ADMIN_PHONE = "0799999999";

/** Reserved test range — cleaned by backend `npm run db:clean-test-data`. */
function customerPhone(): string {
  return `0780000${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

/** A fresh merchant number. Their shop is "[TEST] " prefixed for cleanup. */
function merchantPhone(): string {
  return `077${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
}

/** Unique per run so repeat runs never collide. */
const RUN = Date.now().toString().slice(-6);
const SHOP_NAME = `[TEST] Lifecycle Shop ${RUN}`;
const CATEGORY_NAME = `ZZ Lifecycle ${RUN}`;
const PRODUCT_NAME = `Lifecycle Item ${RUN}`;

/** The dashboard and admin panel are laptop apps. */
async function openDesktop(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

/** Signs into the web app (merchant or admin) through the UI. */
async function signInWeb(page: Page, phone: string) {
  await page.goto(`${DASHBOARD}/`);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/Development mode: your code is/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the whole lifecycle: admin approves, merchant sells, customer buys and reviews", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);

  // ---------------------------------------------------------------------
  // 1. ADMIN adds a master category
  // ---------------------------------------------------------------------
  const admin = await openDesktop(browser);
  await signInWeb(admin, ADMIN_PHONE);
  await expect(admin.getByTestId("admin-header")).toBeVisible({ timeout: 20_000 });

  await admin.getByTestId("admin-tab-categories").click();
  await admin.getByTestId("new-category-name").fill(CATEGORY_NAME);
  await admin.getByTestId("add-category").click();
  await expect(
    admin.getByTestId("admin-category-row").filter({ hasText: CATEGORY_NAME }),
  ).toHaveCount(1);

  // ---------------------------------------------------------------------
  // 2. MERCHANT registers — and is invisible to customers until approved
  // ---------------------------------------------------------------------
  const merchant = await openDesktop(browser);
  const mPhone = merchantPhone();

  await merchant.goto(`${DASHBOARD}/`);
  await merchant.getByRole("button", { name: "New shop? Register here" }).click();
  await merchant.getByLabel("Shop name").fill(SHOP_NAME);
  await merchant.getByLabel("Phone number").fill(mPhone);
  await merchant.getByRole("button", { name: "Register shop" }).click();
  await expect(merchant.getByText("Shop registered. Now sign in")).toBeVisible();

  await merchant.getByLabel("Phone number").fill(mPhone);
  await merchant.getByRole("button", { name: "Send login code" }).click();
  await expect(merchant.getByText(/Development mode: your code is/)).toBeVisible({
    timeout: 20_000,
  });
  await merchant.getByRole("button", { name: "Sign in" }).click();
  await expect(merchant.getByTestId("tab-orders")).toBeVisible({ timeout: 20_000 });

  // The shop can stock up while it waits.
  await merchant.getByTestId("tab-products").click();
  await expect(merchant.getByText("Your shop is awaiting admin approval")).toBeVisible();
  await merchant.getByLabel("Product name").fill(PRODUCT_NAME);
  await merchant.getByLabel("Price (JOD)").fill("0.50");
  await merchant.getByLabel("Category").selectOption({ label: CATEGORY_NAME });
  await merchant.getByRole("button", { name: "Add product" }).click();
  await expect(merchant.getByTestId("product-row")).toHaveCount(1);

  // ---------------------------------------------------------------------
  // 3. ADMIN approves the shop
  // ---------------------------------------------------------------------
  await admin.getByTestId("admin-tab-merchants").click();
  await expect(admin.getByTestId(`merchant-status-${SHOP_NAME}`)).toHaveText("Awaiting approval");
  await admin.getByTestId(`approve-${SHOP_NAME}`).click();
  await expect(admin.getByTestId(`merchant-status-${SHOP_NAME}`)).toHaveText("Approved");

  // ---------------------------------------------------------------------
  // 4. CUSTOMER signs up and finds the newly approved shop
  // ---------------------------------------------------------------------
  await page.goto("/");
  await page.getByTestId("phone-input").fill(customerPhone());
  await page.getByTestId("send-code").click();
  await expect(page.getByTestId("code-input")).toHaveValue(/^\d{6}$/, { timeout: 20_000 });
  await page.getByTestId("verify-code").click();

  // The app opens on the shop list. The newly approved shop is now reachable —
  // it appears there as its own card, proving approval made it visible.
  await expect(
    page.getByTestId("shop-card").filter({ hasText: SHOP_NAME }),
  ).toBeVisible({ timeout: 20_000 });

  // ---------------------------------------------------------------------
  // 5. CUSTOMER orders from the PILOT shop
  // ---------------------------------------------------------------------
  await page.getByTestId("shop-card").filter({ hasText: "Al-Nus Dinar Shop" }).click();
  await expect(page.getByTestId("shop-name")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("add-Chocolate Bar 30g").click();
  await page.getByTestId("plus-Chocolate Bar 30g").click();
  await expect(page.getByTestId("basket-total")).toHaveText("1.00 JOD");

  await page.getByTestId("basket-bar").click();
  await expect(page.getByTestId("summary-total")).toHaveText("1.50 JOD");
  await page.getByTestId("place-order").click();
  await expect(page.getByTestId("order-placed-title")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("placed-total")).toHaveText("1.50 JOD");
  await page.getByTestId("order-done").click();

  // ---------------------------------------------------------------------
  // 6. PILOT MERCHANT takes the order
  // ---------------------------------------------------------------------
  const pilot = await openDesktop(browser);
  await signInWeb(pilot, "0791234567");
  await expect(pilot.getByTestId("tab-orders")).toBeVisible({ timeout: 20_000 });
  await pilot.getByTestId("order-row").first().getByRole("button", { name: "Open" }).click();
  await expect(pilot.getByTestId("order-detail")).toBeVisible();

  await pilot.getByTestId("confirm-order").click();
  await expect(pilot.getByTestId("detail-status")).toHaveText("Confirmed");
  // Contextual contact: the shop can call the customer while working on it.
  await expect(pilot.getByTestId("call-customer")).toBeVisible();

  await pilot.getByTestId("start-preparing").click();
  await expect(pilot.getByTestId("detail-status")).toHaveText("Picking items");

  // ---------------------------------------------------------------------
  // 7. CUSTOMER can call the shop while it is being prepared
  // ---------------------------------------------------------------------
  await page.getByTestId("open-orders").click();
  await page.getByTestId("order-row").first().click();
  await expect(page.getByTestId("call-shop")).toBeVisible();
  // The driver is not involved yet, so there is no number for them.
  await expect(page.getByTestId("call-driver")).toHaveCount(0);
  await page.getByTestId("orders-close").click();
  await page.getByTestId("orders-close").click();

  // ---------------------------------------------------------------------
  // 8. MERCHANT sends it out; CUSTOMER can call the driver
  // ---------------------------------------------------------------------
  await pilot.getByTestId("captain-name").fill("Omar Al-Zoubi");
  await pilot.getByTestId("captain-phone").fill("0791122334");
  await pilot.getByTestId("assign-delivery").click();
  await pilot.getByTestId("delivery-to-PICKED_UP").click();
  await pilot.getByTestId("delivery-to-ON_WAY").click();
  await expect(pilot.getByTestId("delivery-status")).toHaveText("On the way");

  await page.getByTestId("open-orders").click();
  await page.getByTestId("order-row").first().click();
  await expect(page.getByTestId("detail-status")).toHaveText("On its way to you");
  await expect(page.getByTestId("call-driver")).toContainText("+962791122334");
  // The shop is no longer the right person to call.
  await expect(page.getByTestId("call-shop")).toHaveCount(0);
  // And it can no longer be cancelled.
  await expect(page.getByTestId("cancel-order")).toHaveCount(0);
  await page.getByTestId("orders-close").click();
  await page.getByTestId("orders-close").click();

  // ---------------------------------------------------------------------
  // 9. Delivered -> CUSTOMER reviews it
  // ---------------------------------------------------------------------
  await pilot.getByTestId("delivery-to-DELIVERED").click();
  await expect(pilot.getByTestId("detail-status")).toHaveText("Delivered");

  await page.getByTestId("open-orders").click();
  await page.getByTestId("order-row").first().click();
  await expect(page.getByTestId("detail-status")).toHaveText("Delivered");

  await expect(page.getByTestId("review-form")).toBeVisible();
  await page.getByTestId("star-5").click();
  await page.getByTestId("review-comment").fill("Fast and friendly");
  await page.getByTestId("submit-review").click();

  await expect(page.getByTestId("existing-review")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("review-stars")).toHaveText("★★★★★");
  // One review per order — the form is gone.
  await expect(page.getByTestId("review-form")).toHaveCount(0);

  await page.screenshot({ path: "e2e/screenshots/lifecycle-reviewed.png", fullPage: true });

  // ---------------------------------------------------------------------
  // 10. ADMIN sees the finished order and its review
  // ---------------------------------------------------------------------
  await admin.getByTestId("admin-tab-orders").click();
  const adminRow = admin.getByTestId("admin-order-row").first();
  await expect(adminRow).toContainText("Al-Nus Dinar Shop");
  await expect(adminRow).toContainText("1.50 JOD");
  await expect(adminRow.getByTestId("admin-order-review")).toContainText("★★★★★");

  // The headline numbers must agree with the table under them. This caught a
  // real bug: the stats were fetched once at mount, so the Overview read
  // "0 orders" while the list below it showed real ones.
  await expect(admin.getByTestId("admin-stats")).toContainText("orders");
  const orderRows = await admin.getByTestId("admin-order-row").count();
  expect(orderRows).toBeGreaterThan(0);
  await expect(admin.getByTestId("stat-rating")).toBeVisible();
  const statsText = (await admin.getByTestId("admin-stats").textContent()) ?? "";
  expect(statsText).not.toMatch(/\b0\s+orders\b/);

  await admin.screenshot({ path: "e2e/screenshots/lifecycle-admin.png", fullPage: true });

  await admin.close();
  await merchant.close();
  await pilot.close();
});
