import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import type { AppConfiguration } from '../../config/configuration';
import { generateOpaqueToken, pkceChallenge, safeEqual } from '../crypto.util';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_TTL_SECONDS = 10 * 60;

/** Identity asserted by a verified Google ID token. */
export interface GoogleProfile {
  /** Stable Google account id (`sub`). */
  subject: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/** Contents of the signed, httpOnly state cookie. */
interface OAuthStatePayload {
  type: 'oauth_state';
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

/** Failure during the callback, mapped to a code the frontend can show. */
export class GoogleOAuthError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'invalid_state'
      | 'exchange_failed'
      | 'invalid_id_token'
      | 'email_not_verified',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/**
 * Google Sign-In over OpenID Connect, authorization-code flow.
 *
 *  - `state` (CSRF) and `nonce` (ID-token replay) are random per attempt.
 *  - PKCE (S256) binds the code to this browser even if it leaks.
 *  - All three live in a short-lived signed httpOnly cookie, so no server-side
 *    storage is needed and an attempt cannot be completed from another browser.
 *  - The ID token is verified with Google's published keys: signature, `iss`,
 *    `aud` (our client id), `exp`, plus our `nonce` and `email_verified`.
 */
@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);
  private client?: OAuth2Client;

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly jwt: JwtService,
  ) {}

  isConfigured(): boolean {
    const google = this.config.get('google', { infer: true });
    return Boolean(
      google.enabled &&
      google.clientId &&
      google.clientSecret &&
      google.redirectUri,
    );
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw AppError.unavailable(
        ErrorCode.OAuthNotConfigured,
        'Google sign-in is not configured on this server',
      );
    }
  }

  /** Builds the Google consent URL and the signed state to store in a cookie. */
  async createAuthorization(returnTo: string): Promise<{
    url: string;
    stateCookie: string;
    maxAgeMs: number;
  }> {
    this.assertConfigured();
    const google = this.config.get('google', { infer: true });

    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const verifier = generateOpaqueToken(48); // 64 chars, within RFC 7636's 43–128

    const params = new URLSearchParams({
      client_id: google.clientId as string,
      redirect_uri: google.redirectUri as string,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
      include_granted_scopes: 'false',
    });

    const payload: OAuthStatePayload = {
      type: 'oauth_state',
      state,
      verifier,
      nonce,
      returnTo,
    };
    const stateCookie = await this.jwt.signAsync(
      payload,
      this.stateJwtOptions(),
    );

    return {
      url: `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`,
      stateCookie,
      maxAgeMs: STATE_TTL_SECONDS * 1_000,
    };
  }

  /**
   * Validates the callback against the state cookie, exchanges the code and
   * verifies the ID token. Returns the profile plus the `returnTo` captured at
   * the start of the flow.
   */
  async completeAuthorization(params: {
    code?: string;
    state?: string;
    error?: string;
    stateCookie: string | null;
  }): Promise<{ profile: GoogleProfile; returnTo: string }> {
    this.assertConfigured();

    if (params.error) {
      throw new GoogleOAuthError(
        'access_denied',
        `Google returned error: ${params.error}`,
      );
    }

    const saved = await this.readState(params.stateCookie);
    if (!params.state || !safeEqual(params.state, saved.state)) {
      throw new GoogleOAuthError('invalid_state', 'OAuth state mismatch');
    }
    if (!params.code || params.code.length > 2048) {
      throw new GoogleOAuthError(
        'exchange_failed',
        'Missing authorization code',
      );
    }

    const client = this.getClient();
    let idToken: string | null | undefined;
    try {
      const { tokens } = await client.getToken({
        code: params.code,
        codeVerifier: saved.verifier,
      });
      idToken = tokens.id_token;
    } catch (error) {
      this.logger.warn(`Google code exchange failed: ${describe(error)}`);
      throw new GoogleOAuthError(
        'exchange_failed',
        'Could not exchange authorization code',
      );
    }
    if (!idToken) {
      throw new GoogleOAuthError(
        'exchange_failed',
        'Google returned no ID token',
      );
    }

    return {
      profile: await this.verifyIdToken(idToken, saved.nonce),
      returnTo: saved.returnTo,
    };
  }

  /** Verifies a Google ID token and extracts the profile. */
  async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<GoogleProfile> {
    const google = this.config.get('google', { infer: true });
    let payload;
    try {
      const ticket = await this.getClient().verifyIdToken({
        idToken,
        audience: google.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(`Google ID token rejected: ${describe(error)}`);
      throw new GoogleOAuthError(
        'invalid_id_token',
        'ID token verification failed',
      );
    }

    if (!payload?.sub || !payload.email) {
      throw new GoogleOAuthError(
        'invalid_id_token',
        'ID token lacks subject or email',
      );
    }
    if (!payload.nonce || !safeEqual(payload.nonce, expectedNonce)) {
      throw new GoogleOAuthError('invalid_id_token', 'ID token nonce mismatch');
    }
    if (payload.email_verified !== true) {
      throw new GoogleOAuthError(
        'email_not_verified',
        'Google account email is not verified',
      );
    }

    return {
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      name: payload.name?.trim().slice(0, 120) || null,
      picture: payload.picture?.startsWith('https://')
        ? payload.picture.slice(0, 2048)
        : null,
    };
  }

  private async readState(cookie: string | null): Promise<OAuthStatePayload> {
    if (!cookie) {
      throw new GoogleOAuthError(
        'invalid_state',
        'OAuth state cookie missing or expired',
      );
    }
    try {
      const payload = await this.jwt.verifyAsync<OAuthStatePayload>(cookie, {
        ...this.stateJwtOptions(),
        algorithms: ['HS256'],
      });
      if (payload.type !== 'oauth_state') throw new Error('wrong token type');
      return payload;
    } catch (error) {
      throw new GoogleOAuthError(
        'invalid_state',
        `OAuth state cookie invalid: ${describe(error)}`,
      );
    }
  }

  private stateJwtOptions(): {
    secret: string;
    issuer: string;
    audience: string;
    expiresIn: number;
  } {
    const auth = this.config.get('auth', { infer: true });
    return {
      secret: auth.oauthStateSecret,
      issuer: auth.issuer,
      audience: `${auth.audience}:oauth-state`,
      expiresIn: STATE_TTL_SECONDS,
    };
  }

  private getClient(): OAuth2Client {
    const google = this.config.get('google', { infer: true });
    this.client ??= new OAuth2Client({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      redirectUri: google.redirectUri,
    });
    return this.client;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
