import type { Request } from 'express';

import type { AuthenticatedUser } from '../../auth/auth.types';

/**
 * An Express request after `JwtAuthGuard` has run.
 *
 * Passport assigns to `request.user`, so typing it explicitly avoids `any`
 * leaking through controllers and guards.
 */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
