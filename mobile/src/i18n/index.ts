/**
 * Internationalisation for the customer app (Arabic / English, with RTL).
 *
 * Standard i18next + react-i18next so new strings are one line in en.json/ar.json
 * and `t("key")` in a component — no code churn as the app grows.
 *
 * DESIGN NOTES a future session must not "simplify":
 *
 *  1. **Default is Arabic** — the pilot's market. English is opt-in and remembered.
 *  2. **Init is synchronous** (resources are bundled JSON, no async backend), so the
 *     very first render already has strings. The persisted override is applied
 *     during the existing startup splash, before any screen shows — see
 *     restoreLanguage(), called from App.tsx.
 *  3. **Persistence is a PLAIN localStorage key on web**, not AsyncStorage's opaque
 *     backend, so the Playwright suite can force a known language with one
 *     addInitScript. On a device it uses AsyncStorage (language is not sensitive,
 *     so it does not belong in the encrypted keystore the token uses).
 *  4. **RTL on native needs an app reload to fully apply** (I18nManager.forceRTL).
 *     We flip it and reload on an explicit user toggle; on silent startup restore
 *     we set it without a reload to avoid a boot loop. react-native-web does NOT
 *     fully mirror RTL, so on web we additionally set document.dir — that is what
 *     makes the direction real (and testable) on the web target.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { I18nManager, Platform } from "react-native";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ar from "./ar.json";

export const LANGS = ["ar", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** DISTINCT per app so two apps installed side by side never clash. */
export const LANG_KEY = "halfdinar.customer.lang";
export const DEFAULT_LANG: Lang = "ar";

export function isLang(v: unknown): v is Lang {
  return v === "ar" || v === "en";
}

export function isRTL(lang: Lang): boolean {
  return lang === "ar";
}

// Synchronous init — resources are bundled, so the first render has strings.
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ar: { translation: ar },
  },
  lng: DEFAULT_LANG,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
  compatibilityJSON: "v4",
});

/** Reads the persisted language (plain key on web, AsyncStorage on native). */
async function readStored(): Promise<Lang | null> {
  try {
    if (Platform.OS === "web") {
      const v = globalThis.localStorage?.getItem(LANG_KEY);
      return isLang(v) ? v : null;
    }
    const v = await AsyncStorage.getItem(LANG_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

async function writeStored(lang: Lang): Promise<void> {
  try {
    if (Platform.OS === "web") {
      globalThis.localStorage?.setItem(LANG_KEY, lang);
    } else {
      await AsyncStorage.setItem(LANG_KEY, lang);
    }
  } catch {
    // Not persisting is a minor annoyance (one language re-pick), never fatal.
  }
}

/** Applies text direction for a language. `reload` only on an explicit toggle. */
function applyDirection(lang: Lang, reload: boolean): void {
  const rtl = isRTL(lang);
  if (Platform.OS === "web") {
    const doc = (globalThis as { document?: Document }).document;
    if (doc?.documentElement) {
      doc.documentElement.dir = rtl ? "rtl" : "ltr";
      doc.documentElement.lang = lang;
    }
    return;
  }
  try {
    I18nManager.allowRTL(rtl);
    if (I18nManager.isRTL !== rtl) {
      I18nManager.forceRTL(rtl);
      // forceRTL only takes full effect after a reload. On an explicit toggle we
      // trigger one; on silent restore we do not (it would loop the boot).
      if (reload) reloadNative();
    }
  } catch {
    // I18nManager can be unavailable in some test environments — never fatal.
  }
}

/** Best-effort JS reload so a native RTL flip applies immediately. */
function reloadNative(): void {
  try {
    // Works in Expo Go and dev/EAS builds. Absent in some environments → no-op,
    // and the flip then applies on the next natural launch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DevSettings } = require("react-native") as typeof import("react-native");
    if (typeof DevSettings?.reload === "function") DevSettings.reload();
  } catch {
    // Nothing else to do — the direction is set and applies next launch.
  }
}

/**
 * Restores the saved language at startup. Call once from App.tsx during the
 * splash, before rendering any screen. Returns the language in effect.
 */
export async function restoreLanguage(): Promise<Lang> {
  const stored = (await readStored()) ?? DEFAULT_LANG;
  if (i18n.language !== stored) await i18n.changeLanguage(stored);
  applyDirection(stored, false);
  return stored;
}

/** Switches language on an explicit user action: persist, translate, re-direct. */
export async function setLanguage(lang: Lang): Promise<void> {
  await writeStored(lang);
  await i18n.changeLanguage(lang);
  applyDirection(lang, true);
}

export function currentLang(): Lang {
  return isLang(i18n.language) ? i18n.language : DEFAULT_LANG;
}

export default i18n;
