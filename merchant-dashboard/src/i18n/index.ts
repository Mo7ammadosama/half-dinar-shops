/**
 * Internationalisation for the admin console (Arabic / English, with RTL).
 *
 * Standard i18next + react-i18next. Web is simpler than the two React Native
 * apps: there is no I18nManager, and localStorage is synchronous, so the saved
 * language is applied at module load and the very first render is already in the
 * right language and direction. Direction is a plain `dir` attribute on <html>,
 * which the browser mirrors natively (unlike react-native-web).
 *
 *  - Default is Arabic (the pilot's market); English is opt-in and remembered.
 *  - The persisted key is DISTINCT from the two mobile apps.
 *  - The e2e suite forces a known language via this localStorage key before load.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ar from "./ar.json";

export const LANGS = ["ar", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_KEY = "halfdinar.admin.lang";
export const DEFAULT_LANG: Lang = "ar";

function readStored(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "ar" || v === "en") return v;
  } catch {
    // no-op
  }
  return DEFAULT_LANG;
}

export function applyDirection(lang: Lang): void {
  const root = document.documentElement;
  root.dir = lang === "ar" ? "rtl" : "ltr";
  root.lang = lang;
}

const initial = readStored();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ar: { translation: ar },
  },
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
  compatibilityJSON: "v4",
});

applyDirection(initial);

export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not persisting costs one re-pick; never fatal.
  }
  void i18n.changeLanguage(lang);
  applyDirection(lang);
}

export function currentLang(): Lang {
  return i18n.language === "ar" || i18n.language === "en" ? (i18n.language as Lang) : DEFAULT_LANG;
}

export default i18n;
