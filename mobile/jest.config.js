// jest-expo simulates the NATIVE environment: Platform.OS is 'ios'/'android'
// (not 'web'), and Expo/native modules are mocked. This is the closest thing to
// running on a real device without one — it catches render-time crashes that the
// web target never hits.
module.exports = {
  preset: "jest-expo",
  // Both extensions: component tests are .test.tsx, plain logic tests (e.g.
  // imageSrc) are .test.ts. Matching only .tsx silently ignored the latter —
  // the file ran zero tests and reported green.
  testMatch: ["**/__tests__/**/*.test.@(ts|tsx)"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  // The app has no native-only transitive deps that need transforming beyond
  // what jest-expo already whitelists.
};
