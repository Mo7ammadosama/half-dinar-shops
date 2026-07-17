/**
 * The customer app's design system, in one place so every screen stays coherent.
 *
 * This is a mobile-first token set: a small colour palette with a clear brand
 * identity, a type scale, a spacing scale, corner radii and one soft shadow.
 * Screens should compose from these tokens rather than hard-coding values, so the
 * whole app reads as one product.
 *
 * NOTE: every colour key that existed before the design pass is kept, so the
 * screens that already import `colors` keep working unchanged.
 */

export const colors = {
  // Surfaces
  bg: "#f3f5f7", // app background — a soft cool grey
  card: "#ffffff", // cards, headers, sheets
  cardAlt: "#f8fafc", // subtle inset panels

  // Text
  ink: "#0f172a", // primary text (slate-900)
  inkSoft: "#334155", // secondary text (slate-700)
  muted: "#64748b", // hints, meta (slate-500)
  faint: "#94a3b8", // placeholders, disabled (slate-400)
  line: "#e6e9ee", // hairline borders

  // Brand — teal, evoking value + freshness for an everyday grocer
  brand: "#0f766e", // teal-700, primary actions
  brandDark: "#115e59", // pressed / gradient end
  brandDarker: "#0c4a44", // deep header background
  brandSoft: "#ecfdf5", // brand-tinted surfaces
  brandBorder: "#a7f3d0", // brand-tinted borders

  // Accent — warm amber for prices and highlights
  accent: "#b45309", // amber-700, price text (AA on white)
  accentSoft: "#fffbeb", // amber-tinted surface
  accentBorder: "#fcd34d",

  // Status
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  dangerBorder: "#fecaca",
  ok: "#047857",
  okSoft: "#ecfdf5",
  warn: "#92400e",
  warnSoft: "#fef3c7",
} as const;

/** Spacing scale (px). Use these instead of arbitrary margins/paddings. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

/** Corner radii (px). */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/** Type scale. Weights are RN fontWeight strings. */
export const font = {
  display: { fontSize: 24, fontWeight: "800" as const, letterSpacing: -0.3 },
  h1: { fontSize: 20, fontWeight: "800" as const, letterSpacing: -0.2 },
  h2: { fontSize: 17, fontWeight: "800" as const },
  h3: { fontSize: 15, fontWeight: "700" as const },
  body: { fontSize: 15, fontWeight: "500" as const },
  bodyStrong: { fontSize: 15, fontWeight: "700" as const },
  small: { fontSize: 13, fontWeight: "500" as const },
  tiny: { fontSize: 11, fontWeight: "700" as const },
} as const;

/** One soft elevation for cards. Cross-platform (iOS shadow + Android elevation). */
export const shadow = {
  card: {
    shadowColor: "#0f172a",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  bar: {
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
} as const;
