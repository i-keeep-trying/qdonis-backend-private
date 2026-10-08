import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Opts a route out of the globally-registered {@link JwtAuthGuard}.
 *
 * Authentication is deny-by-default: the guard is applied application-wide, so
 * endpoints that must be reachable without a token (login, register, health)
 * have to say so explicitly. Forgetting the decorator fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
