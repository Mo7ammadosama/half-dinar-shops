import { type Page } from "@playwright/test";

/** The persisted-language key the admin console reads on load (src/i18n/index.ts). */
export const ADMIN_LANG_KEY = "halfdinar.admin.lang";

/**
 * Pins the console to a known language for a test.
 *
 * The console defaults to Arabic; existing specs assert English chrome
 * ("Send login code", "administrators only", status labels), so they run in
 * English. `addInitScript` seeds localStorage before the first navigation.
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
    [ADMIN_LANG_KEY, lang] as const,
  );
}

export const forceEnglish = (page: Page) => forceLanguage(page, "en");
