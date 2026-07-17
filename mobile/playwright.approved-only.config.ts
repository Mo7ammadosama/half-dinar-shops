import { defineConfig, devices } from "@playwright/test";

/**
 * Runs ONLY approved-only.spec.ts.
 *
 * Those two tests each assert one side of the approved-only rule and are only
 * valid for one shop status each, so they are driven by
 * scripts/verify-approved-only.sh, which flips the pilot shop's status between
 * them. They are excluded from the default config for that reason.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/approved-only.spec.ts"],
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: [],
  },
  projects: [{ name: "mobile-web", use: { ...devices["Pixel 7"] } }],
});
