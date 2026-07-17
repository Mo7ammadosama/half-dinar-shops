/**
 * Native render smoke test.
 *
 * Renders the app under jest-expo, which reports Platform.OS as a native
 * platform and mocks the Expo native modules — reproducing the environment of a
 * real phone far more closely than the web target, without needing a device.
 *
 * The point is to catch a render-time crash that only happens on native. The web
 * target (react-native-web) papers over several such crashes, which is why the
 * app worked in the browser but not in Expo Go.
 */
import { act, create } from "react-test-renderer";
import React from "react";

// Silence the expected act() warnings from async effects; a real crash still throws.
jest.spyOn(console, "error").mockImplementation(() => {});

/**
 * Every screen fetches on mount. Left unstubbed, those requests hit a server
 * that is not running, and reject *after* the test has finished — React then
 * calls setState on an unmounted tree and Jest reports "Cannot log after tests
 * are done". That failure is timing-dependent: it stays hidden while this is
 * the only suite, and appears as soon as another suite runs alongside it.
 *
 * Stubbing fetch makes the mount deterministic. This test's job is to prove the
 * screens *render* under a native environment — the API contract is covered by
 * the backend suite and the Playwright specs, which use a real server.
 */
beforeEach(() => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
});

afterEach(() => jest.restoreAllMocks());

async function renderAndSettle(element: React.ReactElement) {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(element);
  });
  // Flush the mount effects (session restore, first fetch) and everything they
  // chain into. A single `await Promise.resolve()` only drains one microtask,
  // which was not enough to settle the fetch chain.
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
  return tree!;
}

it("renders the app root without crashing on native", async () => {
  const App = require("../App").default;
  const tree = await renderAndSettle(<App />);
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the login screen (first screen a new user sees) on native", async () => {
  const { LoginScreen } = require("../src/LoginScreen");
  const tree = await renderAndSettle(<LoginScreen onSignedIn={() => {}} />);
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the shop list (the landing screen) on native", async () => {
  const { ShopsScreen } = require("../src/ShopsScreen");
  const tree = await renderAndSettle(
    <ShopsScreen
      onSelectShop={() => {}}
      onSignOut={() => {}}
      place={{ kind: "unset" }}
      onPlaceChange={() => {}}
      savedArea={null}
      onAreaChosen={() => {}}
    />,
  );
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the browse screen for a shop on native", async () => {
  const { BrowseScreen } = require("../src/BrowseScreen");
  const shop = {
    id: "00000000-0000-4000-8000-000000000000",
    shopName: "Al-Nus Dinar Shop",
    locationLat: 31.9539,
    locationLng: 35.9106,
    openingHours: "08:00-23:00",
    productCount: 20,
  };
  const tree = await renderAndSettle(<BrowseScreen shop={shop} onBack={() => {}} />);
  expect(tree.toJSON()).toBeTruthy();
});

it("resolves an API base URL from the Expo host on native", () => {
  const { API_BASE } = require("../src/api");
  expect(typeof API_BASE).toBe("string");
  expect(API_BASE).toMatch(/\/api$/);
});
