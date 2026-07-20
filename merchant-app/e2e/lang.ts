import { type Page } from "@playwright/test";

/**
 * The persisted-language key the merchant app reads on web (src/i18n/index.ts).
 * Kept here so the e2e suite forces a KNOWN language before the app loads.
 */
export const MERCHANT_LANG_KEY = "halfdinar.merchant.lang";

/**
 * Pins the UI to English for a test.
 *
 * The app defaults to Arabic (the pilot's market). Existing specs assert English
 * chrome ("Send code", "This app is for shop owners", status labels), so they run
 * in English — and this keeps them meaningful rather than rewriting every string
 * assertion. `addInitScript` seeds localStorage before the first navigation, so
 * i18n picks it up on the very first render. Product/price/category assertions are
 * server DATA and read the same in any language.
 */
export async function forceLanguage(page: Page, lang: "ar" | "en"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ignore — a storage-less environment falls back to the Arabic default.
      }
    },
    [MERCHANT_LANG_KEY, lang] as const,
  );
}

export const forceEnglish = (page: Page) => forceLanguage(page, "en");
