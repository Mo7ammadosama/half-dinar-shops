/**
 * Jordanian phone number handling.
 *
 * Numbers are stored E.164-normalized (+9627XXXXXXXX) so the same person always
 * maps to the same `users` row regardless of how they typed their number.
 *
 * Jordanian mobile prefixes are 077 (Umniah), 078 (Orange) and 079 (Zain).
 */

/** Matches a fully normalized Jordanian mobile number. */
export const JORDANIAN_PHONE_E164 = /^\+9627[789]\d{7}$/;

/**
 * Normalizes common ways of writing a Jordanian mobile number into E.164.
 *
 * Accepts: +962791234567, 00962791234567, 0791234567, 791234567 — with or
 * without spaces, dashes or parentheses.
 *
 * Returns null when the input is not a valid Jordanian mobile number, so callers
 * can reject it rather than storing something malformed.
 */
export function normalizeJordanianPhone(input: string): string | null {
  if (typeof input !== "string") return null;

  // Strip everything a human might use as separators.
  let digits = input.replace(/[\s\-().]/g, "");

  // Convert the international-access prefix to the + form.
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;

  let national: string;
  if (digits.startsWith("+962")) {
    national = digits.slice(4);
  } else if (digits.startsWith("962")) {
    national = digits.slice(3);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1); // local form: 0791234567
  } else {
    national = digits; // bare form: 791234567
  }

  if (!/^\d+$/.test(national)) return null;

  const candidate = `+962${national}`;
  return JORDANIAN_PHONE_E164.test(candidate) ? candidate : null;
}
