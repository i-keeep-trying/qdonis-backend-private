import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

import type { AppConfiguration } from '../../config/configuration';
import { REFRESH_TOKEN_COOKIE } from '../auth.types';

/**
 * Owns the refresh-token cookie so every route sets and clears it with
 * identical attributes (a mismatch leaves the browser holding the old one).
 */
@Injectable()
export class AuthCookies {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  setRefreshToken(response: Response, token: string, expires: Date): void {
    response.cookie(REFRESH_TOKEN_COOKIE, token, {
      ...this.refreshCookieOptions(),
      expires,
    });
  }

  clearRefreshToken(response: Response): void {
    response.clearCookie(REFRESH_TOKEN_COOKIE, this.refreshCookieOptions());
  }

  readRefreshToken(request: Request): string | null {
    return readCookie(request, REFRESH_TOKEN_COOKIE);
  }

  /**
   * `httpOnly` keeps the token away from JavaScript (XSS cannot read it).
   * `path` narrows it to the auth routes so it is not attached to every API
   * request. `SameSite` + the origin check on cookie routes cover CSRF.
   */
  refreshCookieOptions(): CookieOptions {
    const cookies = this.config.get('cookies', { infer: true });
    return {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: cookies.sameSite,
      ...(cookies.domain ? { domain: cookies.domain } : {}),
      path: `${this.authBasePath()}`,
    };
  }

  /** `/api/v1/auth` (or `/auth` without a global prefix). */
  authBasePath(): string {
    const { apiPrefix } = this.config.get('app', { infer: true });
    return apiPrefix ? `/${apiPrefix}/auth` : '/auth';
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
