import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

import type { AuthenticatedUser } from '../../auth/auth.types';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Injects the authenticated user, or one of its properties, into a handler.
 *
 *   findMe(@CurrentUser() user: AuthenticatedUser)
 *   findMe(@CurrentUser('id') userId: string)
 *
 * Only valid on routes behind `JwtAuthGuard`; on a `@Public()` route
 * `request.user` is undefined.
 */
export const CurrentUser = createParamDecorator(
  (
    property: keyof AuthenticatedUser | undefined,
    context: ExecutionContext,
  ):
    | AuthenticatedUser
    | AuthenticatedUser[keyof AuthenticatedUser]
    | undefined => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) return undefined;
    return property ? user[property] : user;
  },
);
