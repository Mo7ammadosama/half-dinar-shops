import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import type { UserRole } from "../../generated/prisma/enums";
import { IS_PUBLIC_KEY, ROLES_KEY } from "./decorators";
import type { AuthenticatedUser } from "./jwt-payload";

/**
 * Global authentication guard.
 *
 * Registered as an APP_GUARD, so every route requires a valid JWT unless it is
 * explicitly marked @Public().
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;
    return super.canActivate(context);
  }
}

/**
 * Global role guard.
 *
 * Enforces @Roles(...) so a customer's token cannot reach merchant or admin
 * endpoints, and vice versa. Routes without @Roles are open to any
 * authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user) return false; // JwtAuthGuard runs first; defensive.

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `This endpoint requires the ${required.join(" or ")} role.`,
      );
    }
    return true;
  }
}
