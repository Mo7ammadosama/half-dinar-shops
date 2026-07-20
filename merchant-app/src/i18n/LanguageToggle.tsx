/**
 * A compact Arabic/English switch shown on the sign-in screen and in the header,
 * so changing language is always one tap away — never buried in a settings menu.
 *
 * Switching re-renders every screen (react-i18next) and flips text direction. On
 * native an RTL change reloads the app to apply layout mirroring (see i18n/index).
 */
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { setLanguage, currentLang, LANGS, type Lang } from "./index";
import { colors, font, radius, space } from "../theme";

/** `onDark` = the toggle sits on a dark surface (e.g. the brand header). */
export function LanguageToggle({ onDark = false }: { onDark?: boolean }) {
  const { t } = useTranslation();
  const active = currentLang();

  return (
    <View
      style={[styles.wrap, onDark ? styles.wrapOnDark : styles.wrapOnLight]}
      testID="lang-toggle"
      accessibilityLabel={t("lang.toggleA11y")}
    >
      {LANGS.map((lng: Lang) => {
        const isActive = lng === active;
        return (
          <TouchableOpacity
            key={lng}
            style={[styles.pill, isActive && (onDark ? styles.pillActiveOnDark : styles.pillActiveOnLight)]}
            onPress={() => {
              if (!isActive) void setLanguage(lng);
            }}
            testID={`lang-${lng}`}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
          >
            <Text
              style={[
                styles.label,
                onDark ? styles.labelOnDark : styles.labelOnLight,
                isActive && (onDark ? styles.labelActiveOnDark : styles.labelActiveOnLight),
              ]}
            >
              {t(`lang.${lng}`)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    borderRadius: radius.pill,
    padding: 2,
    alignSelf: "flex-start",
  },
  wrapOnDark: { backgroundColor: "rgba(255,255,255,0.18)" },
  wrapOnLight: { backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.line },
  pill: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  pillActiveOnDark: { backgroundColor: "#fff" },
  pillActiveOnLight: { backgroundColor: colors.brand },
  label: { ...font.tiny, fontWeight: "700" },
  labelOnDark: { color: "rgba(255,255,255,0.85)" },
  labelOnLight: { color: colors.inkSoft },
  labelActiveOnDark: { color: colors.brandDarker },
  labelActiveOnLight: { color: "#fff" },
});
