/**
 * Location handling for delivery.
 *
 * Design rule: **location is never a gate.** If the customer refuses the
 * permission, the device has it switched off, or the lookup fails, they pick an
 * area from a list and carry on shopping. A half-dinar shop cannot afford to
 * lose a customer over a permission prompt.
 *
 * API per Expo SDK 54 docs: requestForegroundPermissionsAsync() and
 * getCurrentPositionAsync().
 *
 * WHY expo-location is NOT imported at the top of this file:
 *   `expo-location` runs `requireNativeModule('ExpoLocation')` at import time
 *   (see expo-location/build/ExpoLocation.js). If that native module is missing
 *   or throws, importing expo-location crashes — and because App -> BrowseScreen
 *   -> this file forms an eager import chain, that crash would happen at app
 *   STARTUP, before anything renders, taking down the whole app over an optional
 *   feature. Requiring it lazily (only when the customer taps "use my location")
 *   keeps a location problem contained to the location button, where it already
 *   falls back to manual area selection.
 */

// Types only — `import type` is erased at build time and does NOT run the module.
type LocationModule = typeof import("expo-location");

let cached: LocationModule | null = null;

/** Loads expo-location on first use. Throws only if the native module is absent. */
function loadLocation(): LocationModule {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-location") as LocationModule;
  }
  return cached;
}

/**
 * Amman areas served by the pilot, used when GPS is unavailable or refused.
 * Each carries an approximate centroid so the shop list can still sort by
 * distance when the customer picks an area instead of granting GPS.
 */
export const AREA_COORDS: Record<string, { latitude: number; longitude: number }> = {
  "Downtown (Al-Balad)": { latitude: 31.9539, longitude: 35.9106 },
  "Jabal Amman": { latitude: 31.9515, longitude: 35.9239 },
  "Jabal Al-Weibdeh": { latitude: 31.9575, longitude: 35.9037 },
  Abdali: { latitude: 31.9662, longitude: 35.9092 },
  Shmeisani: { latitude: 31.9702, longitude: 35.9003 },
  "Al-Rabieh": { latitude: 31.9889, longitude: 35.8683 },
  Sweifieh: { latitude: 31.9508, longitude: 35.8586 },
  Khalda: { latitude: 31.9931, longitude: 35.8306 },
};

export const MANUAL_AREAS = Object.keys(AREA_COORDS) as ReadonlyArray<string>;

export type LocationResult =
  | { kind: "coords"; latitude: number; longitude: number }
  | { kind: "denied"; canAskAgain: boolean }
  | { kind: "unavailable"; reason: string };

/** How the customer's delivery location was established. */
export type Place =
  | { kind: "gps"; latitude: number; longitude: number }
  | { kind: "area"; area: string }
  | { kind: "unset" };

/**
 * Resolves a Place to coordinates, or null if none are known.
 * A GPS place carries them directly; an area uses its centroid.
 */
export function placeCoords(place: Place): { latitude: number; longitude: number } | null {
  if (place.kind === "gps") return { latitude: place.latitude, longitude: place.longitude };
  if (place.kind === "area") return AREA_COORDS[place.area] ?? null;
  return null;
}

/**
 * Asks for location once and reports what happened.
 *
 * Never throws: every failure is returned as a result the UI can act on, so a
 * location problem can never crash or block the shop.
 */
export async function requestLocation(): Promise<LocationResult> {
  try {
    // Loaded here, not at module top, so a missing native module cannot crash
    // startup — it just makes this one call fall through to the manual fallback.
    const Location = loadLocation();
    const permission = await Location.requestForegroundPermissionsAsync();

    if (!permission.granted) {
      return { kind: "denied", canAskAgain: permission.canAskAgain };
    }

    const position = await Location.getCurrentPositionAsync({});
    return {
      kind: "coords",
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
  } catch (error) {
    // Location services switched off, no fix available, unsupported platform...
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "Location is unavailable",
    };
  }
}

/** Straight-line distance in km. Good enough to tell a customer how far a shop is. */
export function distanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_KM = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(to.latitude - from.latitude);
  const dLng = toRad(to.longitude - from.longitude);

  // Haversine.
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
