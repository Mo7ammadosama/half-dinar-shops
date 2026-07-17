// AsyncStorage's native module is null under jest (it needs a device). This is
// the mock the library documents; it is a jest-only concern — on a real device
// the native module is present. Mocking it lets the render tests exercise the
// screens that persist state without tripping over a test-environment artifact.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
