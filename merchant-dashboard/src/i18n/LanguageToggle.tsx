/**
 * Arabic/English switch, shown on the sign-in card and in the admin top bar so
 * it is always one click away. Switching re-renders the console (react-i18next)
 * and flips the document direction (see i18n/index.ts).
 */
import { useTranslation } from "react-i18next";
import { LANGS, currentLang, setLanguage, type Lang } from "./index";

export function LanguageToggle() {
  const { t } = useTranslation();
  const active = currentLang();

  return (
    <div className="lang-toggle" data-testid="lang-toggle" aria-label={t("lang.toggleA11y")}>
      {LANGS.map((lng: Lang) => (
        <button
          key={lng}
          type="button"
          className={`lang-pill ${lng === active ? "active" : ""}`}
          onClick={() => {
            if (lng !== active) setLanguage(lng);
          }}
          data-testid={`lang-${lng}`}
          aria-pressed={lng === active}
        >
          {t(`lang.${lng}`)}
        </button>
      ))}
    </div>
  );
}
