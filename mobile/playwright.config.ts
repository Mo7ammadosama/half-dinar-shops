import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the Expo **web** target in a real browser.
 *
 * Serial and single-worker: the tests share one API and one database.
 *
 * The Expo dev server is NOT started automatically — its first bundle takes a
 * while and it is normally already running during development. Start it with
 * `npx expo start --web --port 8081` before running these.
 */
export default defineConfig({
  testDir: "./e2e",
  // approved-only.spec.ts is excluded here on purpose: each of its two tests is
  // only valid for one shop status, and the status is flipped between them by
  // scripts/verify-approved-only.sh (which runs them via
  // playwright.approved-only.config.ts). Leaving them in the default run would
  // guarantee one permanent failure — and a suite that is always red teaches
  // everyone to ignore red.
  testIgnore: ["**/approved-only.spec.ts"],
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Location is denied by default, which exercises the manual-area fallback.
    permissions: [],
  },
  projects: [
    {
      name: "mobile-web",
      use: {
        // Pixel 7 gives a real phone viewport and touch support. The viewport
        // MUST come from the device (or be set after the spread) — a viewport
        // in the top-level `use` is silently overridden by the device preset,
        // which would render this mobile app at desktop width.
        ...devices["Pixel 7"],
      },
    },
  ],
});
