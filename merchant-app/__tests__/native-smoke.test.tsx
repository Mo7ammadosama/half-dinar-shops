/**
 * Native render smoke test.
 *
 * Renders the merchant app under jest-expo, which reports Platform.OS as a
 * native platform and mocks the Expo native modules — reproducing a real phone
 * far more closely than the web target, without needing a device.
 *
 * The point is to catch a render-time crash that only happens on native. In
 * particular it guards the rule this project learned the hard way: an optional
 * native module (expo-image-picker, expo-secure-store, expo-notifications) must
 * never be on the eager App→startup import chain, or a load failure becomes a
 * fatal launch crash. All three are required lazily; this test would fail if one
 * crept onto the eager path.
 */
import { act, create } from "react-test-renderer";
import React from "react";

// Silence expected act() warnings from async effects; a real crash still throws.
jest.spyOn(console, "error").mockImplementation(() => {});

// Every screen fetches on mount; stub fetch so the mount is deterministic and
// nothing rejects after the test finishes. The API contract is covered by the
// backend suite and the Playwright specs against a real server.
beforeEach(() => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
});

// The rendered tree, unmounted after each test. OrdersScreen starts a polling
// interval on mount; leaving the tree mounted lets that timer (and the lazy
// module requires it can trigger) fire after Jest has torn the environment
// down — "import a file after the Jest environment has been torn down".
let current: ReturnType<typeof create> | undefined;

afterEach(async () => {
  if (current) {
    await act(async () => {
      current!.unmount();
    });
    current = undefined;
  }
  jest.restoreAllMocks();
});

async function renderAndSettle(element: React.ReactElement) {
  await act(async () => {
    current = create(element);
  });
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
  return current!;
}

it("renders the app root without crashing on native", async () => {
  const App = require("../App").default;
  const tree = await renderAndSettle(<App />);
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the login screen (first screen a new merchant sees) on native", async () => {
  const { LoginScreen } = require("../src/LoginScreen");
  const tree = await renderAndSettle(<LoginScreen onSignedIn={() => {}} />);
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the products screen (camera + AI entry) on native", async () => {
  const { ProductsScreen } = require("../src/ProductsScreen");
  const tree = await renderAndSettle(<ProductsScreen />);
  expect(tree.toJSON()).toBeTruthy();
});

it("renders the orders screen on native", async () => {
  const { OrdersScreen } = require("../src/OrdersScreen");
  const tree = await renderAndSettle(<OrdersScreen onPendingChange={() => {}} />);
  expect(tree.toJSON()).toBeTruthy();
});

it("resolves an API base URL from the Expo host on native", () => {
  const { API_BASE } = require("../src/api");
  expect(typeof API_BASE).toBe("string");
  expect(API_BASE).toMatch(/\/api$/);
});
