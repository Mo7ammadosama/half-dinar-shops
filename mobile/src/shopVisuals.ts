/**
 * Placeholder visuals for when there is no photo.
 *
 * Most seeded products have no image_url yet (photos are uploaded by the merchant
 * later), so an image-less card is the common case, not the exception. Rather than
 * show an empty grey box, we derive a friendly emoji from the product's name /
 * category and a soft tinted background, so a shelf of image-less items still
 * looks intentional and lively.
 *
 * These are cosmetic only — nothing here affects data, prices, or ordering.
 */
import { colors } from "./theme";

/**
 * Ordered keyword → emoji rules. First match on the lowercased name wins, so the
 * more specific rules come first. Sweets are checked BEFORE drinks on purpose:
 * "choColate" contains the substring "cola", so a naive drinks rule would give a
 * chocolate bar a juice-box icon. `\bcola\b` also guards that from the other side.
 */
const NAME_RULES: Array<[RegExp, string]> = [
  [/water|sparkling/, "💧"],
  [/chocolate|wafer|biscuit|cookie|crackers|shortbread|digestive|ma'moul|sesame|snack|peanut/, "🍪"],
  [/juice|mango|orange soda|lemon|iced tea|\bcola\b|soda|\bdrink/, "🧃"],
  [/soap|shampoo|tooth|cotton|face cloth|tissue|personal/, "🧼"],
  [/pen|pencil|notebook|ruler|eraser|sticky|tape|highlighter|sketch|colour pencil|correction/, "✏️"],
  [/sponge|scour|cloth|glove|clean|bin liner|peg|glass cleaner|brush/, "🧽"],
  [/foil|container|spoon|spatula|jug|mug|glass|basket|cling|measuring|kitchen/, "🍽️"],
];

/** Category-level fallback when the name matches nothing specific. */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/drink/, "🧃"],
  [/biscuit|sweet|snack|food/, "🍪"],
  [/personal/, "🧼"],
  [/station/, "✏️"],
  [/clean/, "🧽"],
  [/kitchen|household/, "🍽️"],
];

/** A friendly emoji for a product with no photo. */
export function productEmoji(name: string, categoryPath: string | null): string {
  const n = name.toLowerCase();
  for (const [re, emoji] of NAME_RULES) if (re.test(n)) return emoji;

  const c = (categoryPath ?? "").toLowerCase();
  for (const [re, emoji] of CATEGORY_RULES) if (re.test(c)) return emoji;

  return "🛒";
}

/** Soft background tints for placeholder tiles, chosen deterministically. */
const TILE_TINTS = [
  colors.brandSoft,
  colors.accentSoft,
  "#eff6ff", // blue-50
  "#f5f3ff", // violet-50
  "#fdf2f8", // pink-50
  "#f0fdf4", // green-50
] as const;

/** Stable index from a string so the same item always gets the same tint. */
function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % mod;
}

export function tileTint(seed: string): string {
  return TILE_TINTS[hashIndex(seed, TILE_TINTS.length)];
}

/** A shop's monogram (first letter of its name, ignoring the "[TEST] " marker). */
export function shopMonogram(shopName: string): string {
  const clean = shopName.replace(/^\[TEST\]\s*/, "").trim();
  return (clean[0] ?? "?").toUpperCase();
}
