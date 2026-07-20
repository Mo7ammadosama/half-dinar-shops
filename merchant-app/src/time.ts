/**
 * Human-friendly relative time for order timestamps. A shopkeeper cares far more
 * about "8 min ago" than an absolute clock time when triaging a queue of orders.
 * Falls back to a full local date/time for anything older than a day.
 *
 * Strings are localised via the i18n singleton, so these read in Arabic or
 * English following the current language. Called during render, so a language
 * switch re-renders and re-computes with the new locale. The absolute fallback
 * uses toLocaleString with the active language's locale.
 */
import i18n from "./i18n";

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return i18n.t("time.justNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return i18n.t("time.minAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return i18n.t("time.hAgo", { count: hours });
  return new Date(iso).toLocaleString(i18n.language === "ar" ? "ar-JO" : undefined);
}

/** Whole minutes elapsed since `iso` — used to flag orders left waiting too long. */
export function minutesSince(iso: string, now: number = Date.now()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 60000));
}
