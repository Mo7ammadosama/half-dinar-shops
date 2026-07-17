import { Type } from "class-transformer";
import { IsLatitude, IsLongitude, IsString, Length, Matches } from "class-validator";
import { IsJordanianPhone } from "../common/dto/phone.dto";

export class RegisterMerchantDto {
  @IsJordanianPhone()
  phoneNumber!: string;

  @IsString()
  @Length(2, 120, { message: "shopName must be between 2 and 120 characters" })
  shopName!: string;

  @Type(() => Number)
  @IsLatitude({ message: "locationLat must be a valid latitude" })
  locationLat!: number;

  @Type(() => Number)
  @IsLongitude({ message: "locationLng must be a valid longitude" })
  locationLng!: number;

  /** Free-text for now, e.g. "08:00-23:00". */
  @IsString()
  @Length(3, 120)
  @Matches(/^[0-9:\-\s,A-Za-z]+$/, { message: "openingHours contains invalid characters" })
  openingHours!: string;
}
