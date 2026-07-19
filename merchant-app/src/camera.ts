/**
 * Product photo capture (the reason this app exists on a phone).
 *
 * The whole point of moving the merchant off the web dashboard is that they can
 * stand in front of a shelf, photograph an item, and have its name, category and
 * price filled in for them — instead of typing every field from a laptop. This
 * module wraps expo-image-picker to get that photo, from the camera or the
 * library.
 *
 * It follows the same two rules push.ts and the customer app's location.ts do,
 * both learned the hard way here:
 *
 *  1. **expo-image-picker is required LAZILY, never at module scope.** Its native
 *     binding runs at import time; an eager import of an optional native module
 *     is what crashed this project on a real phone before (expo-location). A
 *     failure to load it degrades to "camera unavailable", not a launch crash.
 *
 *  2. **Nothing here throws.** Every path returns a result the UI can render. A
 *     denied permission, a cancelled picker, or a missing module is a normal
 *     outcome, not an error — the merchant can always type the product in by hand.
 */
import { Platform } from "react-native";
import type * as ImagePickerTypes from "expo-image-picker";
import type { PickedImage } from "./api";

export type CaptureResult =
  | { status: "picked"; image: PickedImage }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "unavailable"; reason: string };

/** Loads expo-image-picker on demand. Null rather than throwing. */
function imagePicker(): typeof ImagePickerTypes | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-image-picker") as typeof ImagePickerTypes;
  } catch {
    return null;
  }
}

/** expo-image-picker assets carry a mimeType + fileName on both platforms. */
function toPicked(asset: ImagePickerTypes.ImagePickerAsset): PickedImage {
  const type = asset.mimeType ?? "image/jpeg";
  // Derive a filename with an extension the backend's magic-byte check is happy
  // to receive; the real validation is on the bytes, not the name.
  const ext = type.split("/")[1] ?? "jpg";
  const name = asset.fileName ?? `product-${Date.now()}.${ext}`;
  return { uri: asset.uri, type, name };
}

/**
 * Opens the camera and returns the photo taken.
 *
 * Web has no camera to launch through expo-image-picker, so on the web target
 * this reports "unavailable" and the UI shows the library button instead.
 */
export async function takePhoto(): Promise<CaptureResult> {
  const picker = imagePicker();
  if (!picker) return { status: "unavailable", reason: "Camera module is not available." };
  if (Platform.OS === "web") {
    return { status: "unavailable", reason: "Use the gallery button on the web preview." };
  }

  try {
    const permission = await picker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: "denied" };

    const result = await picker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]) return { status: "cancelled" };
    return { status: "picked", image: toPicked(result.assets[0]) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Picks an existing photo from the device library (also the web fallback). */
export async function pickFromLibrary(): Promise<CaptureResult> {
  const picker = imagePicker();
  if (!picker) return { status: "unavailable", reason: "Photo library is not available." };

  try {
    // The library does not need camera permission; on modern OSes the picker
    // runs out-of-process and needs no media-library permission either.
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]) return { status: "cancelled" };
    return { status: "picked", image: toPicked(result.assets[0]) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
