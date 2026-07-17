import { IsIn, IsOptional, IsString, IsUUID, Length } from "class-validator";

export class CreateCategoryDto {
  @IsString()
  @Length(2, 80, { message: "name must be between 2 and 80 characters" })
  name!: string;

  /** Omit for a top-level category. */
  @IsOptional()
  @IsUUID(4, { message: "parentCategoryId must be a valid category id" })
  parentCategoryId?: string;
}

export class UpdateCategoryDto {
  @IsString()
  @Length(2, 80, { message: "name must be between 2 and 80 characters" })
  name!: string;
}

/**
 * Sets a shop's status.
 *
 * The schema has no "rejected" state — rejecting and suspending are the same
 * outcome (the shop is invisible to customers and cannot trade), so both map to
 * SUSPENDED. PENDING is allowed so an admin can put a shop back in the queue.
 */
export class SetMerchantStatusDto {
  @IsIn(["PENDING", "APPROVED", "SUSPENDED"], {
    message: "status must be PENDING, APPROVED or SUSPENDED",
  })
  status!: "PENDING" | "APPROVED" | "SUSPENDED";
}
