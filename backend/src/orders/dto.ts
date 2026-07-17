import { Type } from "class-transformer";
import { IsJordanianPhone } from "../common/dto/phone.dto";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

/** Sanity bound: a half-dinar shop order is not 1000 of one item. */
const MAX_QUANTITY_PER_ITEM = 99;

/** Sanity bound on distinct lines in one order. */
const MAX_ITEMS_PER_ORDER = 50;

export class OrderItemInputDto {
  @IsUUID(4, { message: "productId must be a valid product id" })
  productId!: string;

  @Type(() => Number)
  @IsInt({ message: "quantity must be a whole number" })
  @Min(1, { message: "quantity must be at least 1" })
  @Max(MAX_QUANTITY_PER_ITEM)
  quantity!: number;
}

/**
 * Note what is NOT here: **price**.
 *
 * The client never sends prices. The server reads the current price from the
 * database and snapshots that. Accepting a price from the client would let a
 * customer buy anything for 0.00.
 */
export class CreateOrderDto {
  @IsUUID(4, { message: "shopId must be a valid shop id" })
  shopId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: "An order must contain at least one item" })
  @ArrayMaxSize(MAX_ITEMS_PER_ORDER)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** A customer cancelling. The reason is optional — cancelling is their right. */
export class CustomerCancelOrderDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}

/**
 * A merchant cancelling. The reason is **mandatory** per the spec, and is shown
 * to the customer, so it must be a real sentence rather than a stray character.
 */
export class MerchantCancelOrderDto {
  @IsString({ message: "A cancellation reason is required." })
  @Length(3, 500, {
    message: "Please give the customer a real reason (at least 3 characters).",
  })
  reason!: string;
}

export class SetItemStatusDto {
  @IsIn(["CONFIRMED", "UNAVAILABLE"], {
    message: "status must be CONFIRMED or UNAVAILABLE",
  })
  status!: "CONFIRMED" | "UNAVAILABLE";
}

/** A post-delivery review. Rating is 1..5; the comment is optional. */
export class CreateReviewDto {
  @Type(() => Number)
  @IsInt({ message: "rating must be a whole number of stars" })
  @Min(1, { message: "rating must be between 1 and 5" })
  @Max(5, { message: "rating must be between 1 and 5" })
  rating!: number;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;
}

/** Assigns a delivery captain. Their real number is shown to the customer. */
export class AssignDeliveryDto {
  @IsString()
  @Length(2, 120, { message: "captainName must be between 2 and 120 characters" })
  captainName!: string;

  @IsJordanianPhone()
  captainPhone!: string;
}

export class UpdateDeliveryDto {
  @IsIn(["PICKED_UP", "ON_WAY", "DELIVERED", "FAILED"], {
    message: "status must be PICKED_UP, ON_WAY, DELIVERED or FAILED",
  })
  status!: "PICKED_UP" | "ON_WAY" | "DELIVERED" | "FAILED";

  /** Required when marking a delivery FAILED — it cancels the order. */
  @IsOptional()
  @IsString()
  @Length(3, 500)
  note?: string;
}
