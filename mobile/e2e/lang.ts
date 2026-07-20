import { type Page } from "@playwright/test";

/** The persisted-language key the customer app reads on web (src/i18n/index.ts). */
export const CUSTOMER_LANG_KEY = "halfdinar.customer.lang";

/**
 * Pins the UI to a known language for a test.
 *
 * The app defaults to Arabic (the pilot's market); existing specs assert English
 * chrome, so they run in English. `addInitScript` seeds localStorage before the
 * first navigation, so i18n picks it up on the very first render. Product names,
 * prices and shop names are server DATA and read the same in any language.
 */
export async function forceLanguage(page: Page, lang: "ar" | "en"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ignore — falls back to the Arabic default.
      }
    },
    [CUSTOMER_LANG_KEY, lang] as const,
  );
}

export const forceEnglish = (page: Page) => forceLanguage(page, "en");
