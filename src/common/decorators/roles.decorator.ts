import { SetMetadata } from '@nestjs/common';

import type { Role } from '../../generated/prisma/enums';

export const ROLES_KEY = 'auth:roles';

/**
 * Restricts a route to the listed roles. Enforced by `RolesGuard`, which runs
 * after the JWT guard has populated `request.user`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
