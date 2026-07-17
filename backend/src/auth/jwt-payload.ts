import type { UserRole } from "../../generated/prisma/enums";

/** Claims embedded in every issued JWT. */
export interface JwtPayload {
  /** users.id */
  sub: string;
  role: UserRole;
}

/** The authenticated caller, attached to the request by JwtStrategy. */
export interface AuthenticatedUser {
  id: string;
  phoneNumber: string;
  role: UserRole;
  /** Present only for merchant accounts. */
  merchantId?: string;
}
