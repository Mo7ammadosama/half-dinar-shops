import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { UserRole } from "../../generated/prisma/enums";
import type { AuthenticatedUser } from "./jwt-payload";

export const IS_PUBLIC_KEY = "isPublic";
export const ROLES_KEY = "roles";

/**
 * Marks an endpoint as reachable without a JWT.
 *
 * Authentication is global, so this is the *only* way to expose an endpoint
 * publicly — meaning a forgotten decorator leaves a route protected rather than
 * open.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts an endpoint to the listed roles. Enforced by RolesGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated caller resolved by JwtStrategy. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
