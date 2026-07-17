import { Transform } from "class-transformer";
import { IsString, Matches } from "class-validator";
import { JORDANIAN_PHONE_E164, normalizeJordanianPhone } from "../phone";

/**
 * Reusable phone-number field decorator.
 *
 * Normalizes the incoming value to E.164 *before* validation, so a user typing
 * "0791234567" and "+962 79 123 4567" both pass and both store identically.
 * Anything that cannot be normalized is left as-is and then fails @Matches,
 * producing a clear 400 rather than a bad row.
 */
export function IsJordanianPhone() {
  return function (target: object, propertyKey: string) {
    Transform(({ value }: { value: unknown }) =>
      typeof value === "string" ? (normalizeJordanianPhone(value) ?? value) : value,
    )(target, propertyKey);
    IsString()(target, propertyKey);
    Matches(JORDANIAN_PHONE_E164, {
      message: "phoneNumber must be a valid Jordanian mobile number (e.g. 0791234567)",
    })(target, propertyKey);
  };
}
