import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../../common/types/authenticated-request';
import type { Role } from '../../generated/prisma/enums';

/**
 * Enforces `@Roles(...)`.
 *
 * Applied per controller rather than globally, and always after `JwtAuthGuard`,
 * because it reads the role from `request.user`. A route with no `@Roles()`
 * metadata is allowed through — authentication is the global default,
 * authorisation is opt-in per route.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // Reaching here without a user means the route is behind RolesGuard but not
    // JwtAuthGuard, which is a wiring mistake rather than a client error.
    if (!user) {
      throw new ForbiddenException(
        'Authentication is required for this resource',
      );
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        'Insufficient permissions for this resource',
      );
    }

    return true;
  }
}
