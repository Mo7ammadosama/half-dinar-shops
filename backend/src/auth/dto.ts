import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";
import { IsJordanianPhone } from "../common/dto/phone.dto";

export class RequestOtpDto {
  @IsJordanianPhone()
  phoneNumber!: string;
}

export class VerifyOtpDto {
  @IsJordanianPhone()
  phoneNumber!: string;

  @IsString()
  @Length(6, 6, { message: "code must be exactly 6 digits" })
  @Matches(/^\d{6}$/, { message: "code must be exactly 6 digits" })
  code!: string;
}

/** Registers this device so the customer can be reached with the app closed. */
export class RegisterDeviceDto {
  /**
   * An Expo push token. Format-checked so a caller cannot stuff arbitrary text
   * into a column that is later sent to a third-party service.
   */
  @IsString()
  @MaxLength(255)
  @Matches(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/, {
    message: "token must be a valid Expo push token",
  })
  token!: string;

  @IsOptional()
  @IsIn(["ios", "android"])
  platform?: string;
}

/** Forgets a device, so a signed-out phone stops receiving notifications. */
export class UnregisterDeviceDto {
  @IsString()
  @MaxLength(255)
  token!: string;
}
