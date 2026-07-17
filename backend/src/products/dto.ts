import { Type } from "class-transformer";
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";

/** Upper bound on a single item's price. A half-dinar shop item is never 1000 JOD. */
const MAX_PRICE_JOD = 1000;

export class CreateProductDto {
  @IsString()
  @Length(2, 160, { message: "name must be between 2 and 160 characters" })
  name!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "price must have at most 2 decimal places" })
  @Min(0, { message: "price cannot be negative" })
  @Max(MAX_PRICE_JOD)
  price!: number;

  @IsUUID(4, { message: "categoryId must be a valid category id" })
  categoryId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

/**
 * All fields optional — a partial update.
 *
 * Deliberately not built with PartialType(CreateProductDto): the update path
 * must never accept a merchantId, and spelling the fields out keeps that
 * explicit.
 */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "price must have at most 2 decimal places" })
  @Min(0, { message: "price cannot be negative" })
  @Max(MAX_PRICE_JOD)
  price?: number;

  @IsOptional()
  @IsUUID(4)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

export class SetAvailabilityDto {
  @IsBoolean({ message: "isAvailable must be true or false" })
  isAvailable!: boolean;
}
