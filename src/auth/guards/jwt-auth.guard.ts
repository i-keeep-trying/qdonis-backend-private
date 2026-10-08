import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { AppError, ErrorCode } from '../../common/errors/error-codes';

/**
 * Default authentication guard, registered globally in `AppModule`.
 *
 * Deny-by-default: a new controller is protected the moment it is added, and
 * exposing something publicly requires the explicit `@Public()` decorator.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /**
   * Passport reports missing/expired/invalid tokens as `info` with a generic
   * 401; give clients a stable code instead. Errors thrown by the strategy
   * (e.g. SESSION_REVOKED) pass through unchanged.
   */
  override handleRequest<TUser>(
    error: unknown,
    user: TUser | false,
    info: unknown,
  ): TUser {
    if (error instanceof Error) throw error;
    if (error || !user) {
      const expired =
        info instanceof Error && info.name === 'TokenExpiredError';
      throw expired
        ? AppError.unauthorized(
            ErrorCode.AccessTokenExpired,
            'Access token has expired',
          )
        : AppError.unauthorized(
            ErrorCode.Unauthenticated,
            'A valid access token is required',
          );
    }
    return user;
  }
}
