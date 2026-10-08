import {
  Controller,
  Get,
  HttpException,
  Logger,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';

import { AuthThrottle } from '../../common/decorators/auth-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AppConfiguration } from '../../config/configuration';
import { queryString, safeReturnTo, sessionContext } from '../request-context';
import { AuthCookies, readCookie } from '../sessions/auth-cookies.service';
import { GoogleOAuthClient, GoogleOAuthError } from './google-oauth.client';
import { GoogleSignInService } from './google-sign-in.service';

const STATE_COOKIE = 'qd_oauth_google';

/**
 * Browser-redirect endpoints for "Sign in with Google".
 *
 * The SPA navigates (full page, not fetch) to `GET /auth/google?returnTo=/x`.
 * After consent Google redirects to the callback, which sets the refresh
 * cookie and redirects to `${FRONTEND_URL}/auth/callback?returnTo=/x`. The SPA
 * then calls `POST /auth/refresh` to obtain its access token, so no token ever
 * appears in a URL. Failures redirect with `?error=<code>`.
 */
@ApiTags('auth')
@Public()
@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);

  constructor(
    private readonly google: GoogleOAuthClient,
    private readonly signIn: GoogleSignInService,
    private readonly cookies: AuthCookies,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @AuthThrottle()
  @Get()
  @ApiOperation({ summary: 'Start Google sign-in (browser navigation)' })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    description: 'Relative SPA path to land on',
  })
  @ApiFoundResponse({ description: 'Redirect to Google' })
  async start(
    @Query('returnTo') returnTo: unknown,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.google.isConfigured()) {
      return this.redirectToFrontend(response, {
        error: 'oauth_not_configured',
      });
    }
    const { url, stateCookie, maxAgeMs } =
      await this.google.createAuthorization(safeReturnTo(returnTo));
    response.cookie(STATE_COOKIE, stateCookie, {
      ...this.stateCookieOptions(),
      maxAge: maxAgeMs,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, url);
  }

  @AuthThrottle()
  @Get('callback')
  @ApiOperation({
    summary: 'Google OAuth redirect URI (called by Google, not by the SPA)',
  })
  @ApiFoundResponse({ description: 'Redirect to the SPA' })
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const stateCookie = readCookie(request, STATE_COOKIE);
    // Single use: the state cookie is gone whatever happens next.
    response.clearCookie(STATE_COOKIE, this.stateCookieOptions());
    response.setHeader('Cache-Control', 'no-store');

    if (!this.google.isConfigured()) {
      return this.redirectToFrontend(response, {
        error: 'oauth_not_configured',
      });
    }

    try {
      const { profile, returnTo } = await this.google.completeAuthorization({
        code: queryString(code),
        state: queryString(state, 256),
        error: queryString(error, 256),
        stateCookie,
      });
      const issued = await this.signIn.signIn(profile, sessionContext(request));
      this.cookies.setRefreshToken(
        response,
        issued.refreshToken,
        issued.refreshTokenExpiresAt,
      );
      return this.redirectToFrontend(response, { returnTo });
    } catch (failure) {
      return this.redirectToFrontend(response, {
        error: this.toErrorCode(failure),
      });
    }
  }

  private toErrorCode(failure: unknown): string {
    if (failure instanceof GoogleOAuthError) {
      if (failure.code !== 'access_denied') {
        this.logger.warn(
          `Google sign-in failed (${failure.code}): ${failure.message}`,
        );
      }
      return failure.code;
    }
    if (failure instanceof HttpException) {
      const body = failure.getResponse();
      const code =
        typeof body === 'object' && body !== null
          ? (body as { code?: unknown }).code
          : undefined;
      if (typeof code === 'string') return code.toLowerCase();
    }
    this.logger.error(
      `Unexpected Google sign-in failure: ${failure instanceof Error ? failure.message : String(failure)}`,
      failure instanceof Error ? failure.stack : undefined,
    );
    return 'server_error';
  }

  private redirectToFrontend(
    response: Response,
    params: { returnTo?: string; error?: string },
  ): void {
    const { frontendUrl } = this.config.get('app', { infer: true });
    const target = new URL(`${frontendUrl}/auth/callback`);
    if (params.returnTo) target.searchParams.set('returnTo', params.returnTo);
    if (params.error) target.searchParams.set('error', params.error);
    response.redirect(302, target.toString());
  }

  /**
   * Always `SameSite=Lax`: the callback is a top-level cross-site navigation
   * from accounts.google.com, which Lax cookies accompany and Strict ones do
   * not. Scoped to the Google routes only.
   */
  private stateCookieOptions(): CookieOptions {
    const cookies = this.config.get('cookies', { infer: true });
    return {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: 'lax',
      path: `${this.cookies.authBasePath()}/google`,
    };
  }
}
