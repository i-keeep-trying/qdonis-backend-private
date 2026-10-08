import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import type { AppConfiguration } from '../../config/configuration';

/**
 * CSRF defence for the routes authenticated by the refresh cookie
 * (`/auth/refresh`, `/auth/logout`).
 *
 * SameSite already stops most cross-site sends, but `SameSite=None` (needed
 * when the SPA is on another site) does not. Browsers attach `Origin` to every
 * cross-origin POST, so rejecting origins outside `CORS_ORIGINS` closes the
 * gap. Requests with no `Origin` are allowed unless `Sec-Fetch-Site` says they
 * are cross-site — that covers non-browser clients without opening a hole.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get('origin');
    const { origins } = this.config.get('cors', { infer: true });

    if (origin) {
      if (origin !== 'null' && origins.includes(origin)) return true;
      throw AppError.forbidden(
        ErrorCode.OriginNotAllowed,
        'Request origin is not allowed',
      );
    }

    if (request.get('sec-fetch-site') === 'cross-site') {
      throw AppError.forbidden(
        ErrorCode.OriginNotAllowed,
        'Cross-site request rejected',
      );
    }
    return true;
  }
}
