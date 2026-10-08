import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';
import type { Session, User } from '../generated/prisma/client';
import { AuthTokenType } from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import { UserEntity } from '../users/entities/user.entity';
import { PasswordHasher } from '../users/password-hasher.service';
import { UsersService } from '../users/users.service';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
  SessionContext,
} from './auth.types';
import { AuthResultDto, RegisterResultDto } from './dto/auth-result.dto';
import type { ChangePasswordDto, ResetPasswordDto } from './dto/password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { SessionDto } from './dto/session.dto';
import {
  RevocationReason,
  RotationConflictError,
  SessionsService,
} from './sessions/sessions.service';
import { AuthTokensService } from './tokens/auth-tokens.service';

/**
 * What the service hands back to the controller. The refresh token is kept
 * out of `result`: only the controller, which owns the response, writes it as
 * an httpOnly cookie.
 */
export interface IssuedAuth {
  result: AuthResultDto;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const invalidCredentials = () =>
  AppError.unauthorized(
    ErrorCode.InvalidCredentials,
    'Invalid email or password',
  );

const sessionRevoked = () =>
  AppError.unauthorized(
    ErrorCode.SessionRevoked,
    'Session is no longer valid; sign in again',
  );

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessionsService: SessionsService,
    private readonly authTokens: AuthTokensService,
    private readonly mail: MailService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  // --- registration & login -----------------------------------------------

  /**
   * Creates a password account and emails a verification link. When verified
   * email is required for login, no session is started until verification;
   * otherwise the response matches login.
   */
  async register(
    dto: RegisterDto,
    context: SessionContext,
  ): Promise<{
    result: RegisterResultDto;
    session: IssuedAuth | null;
  }> {
    const passwordHash = await this.passwordHasher.hash(dto.password);
    const user = await this.usersService.insert({
      email: dto.email,
      name: dto.name || null,
      passwordHash,
    });

    await this.sendVerificationEmail(user);

    if (this.authConfig().requireVerifiedEmail) {
      return {
        result: new RegisterResultDto(new UserEntity(user), true),
        session: null,
      };
    }

    const session = await this.startSession(user, context);
    return {
      result: new RegisterResultDto(
        new UserEntity(user),
        false,
        session.result,
      ),
      session,
    };
  }

  /**
   * Password login.
   *
   * Every credential failure (unknown email, wrong password, no password set,
   * locked, deactivated) answers the same 401 after the same Argon2 cost, so
   * neither the body nor the timing reveals which emails exist. Only a caller
   * who knows the correct password learns that the email is unverified.
   */
  async login(dto: LoginDto, context: SessionContext): Promise<IssuedAuth> {
    const user = await this.usersService.findRecordByEmail(dto.email);
    if (!user) {
      await this.passwordHasher.burn(dto.password);
      throw invalidCredentials();
    }

    const passwordOk = await this.passwordHasher.verify(
      user.passwordHash,
      dto.password,
    );
    const locked =
      user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();

    if (!passwordOk) {
      // Only count guesses against a real, currently-unlocked password.
      if (user.passwordHash && !locked && user.isActive) {
        await this.usersService.recordFailedLogin(user.id);
      }
      throw invalidCredentials();
    }
    if (locked || !user.isActive) throw invalidCredentials();

    if (
      this.authConfig().requireVerifiedEmail &&
      user.emailVerifiedAt === null
    ) {
      throw AppError.forbidden(
        ErrorCode.EmailNotVerified,
        'Verify your email address before signing in',
      );
    }

    await this.usersService.rehashIfNeeded(user, dto.password);
    const fresh = await this.usersService.recordSuccessfulLogin(user.id);
    return this.startSession(fresh, context);
  }

  /** Starts a session for an already-authenticated user (password or Google). */
  async startSession(user: User, context: SessionContext): Promise<IssuedAuth> {
    const { session, refreshToken } = await this.sessionsService.issue(
      user.id,
      context,
    );
    return this.buildIssued(user, session, refreshToken);
  }

  // --- refresh & logout ----------------------------------------------------

  /**
   * Rotates a refresh token.
   *
   *  - Unknown token → 401 SESSION_REVOKED.
   *  - Token already rotated within the grace window → 401 REFRESH_CONFLICT
   *    (a parallel tab won the race; retry with the newer cookie).
   *  - Token already rotated outside the grace window → theft: the whole
   *    family is revoked, 401 SESSION_REVOKED.
   *  - Past the absolute lifetime → 401 SESSION_EXPIRED.
   */
  async refresh(
    refreshToken: string | null,
    context: SessionContext,
  ): Promise<IssuedAuth> {
    if (!refreshToken) {
      throw AppError.unauthorized(
        ErrorCode.RefreshMissing,
        'Refresh token cookie is missing',
      );
    }
    if (refreshToken.length > 256) throw sessionRevoked();

    const session = await this.sessionsService.findByRefreshToken(refreshToken);
    if (!session) throw sessionRevoked();

    const now = Date.now();

    if (session.revokedAt !== null) {
      await this.handleRevokedRefresh(session, now);
    }

    if (this.sessionsService.absoluteExpiry(session).getTime() <= now) {
      await this.sessionsService.revokeFamily(
        session.familyId,
        RevocationReason.AbsoluteExpiry,
      );
      throw AppError.unauthorized(
        ErrorCode.SessionExpired,
        'Session has expired; sign in again',
      );
    }
    if (session.expiresAt.getTime() <= now) {
      throw AppError.unauthorized(
        ErrorCode.SessionExpired,
        'Session has expired; sign in again',
      );
    }

    const user = await this.usersService.findRecordById(session.userId);
    if (!user || !user.isActive) {
      await this.sessionsService.revokeFamily(
        session.familyId,
        RevocationReason.AccountUnavailable,
      );
      throw sessionRevoked();
    }

    try {
      const rotated = await this.sessionsService.rotate(session, context);
      return this.buildIssued(user, rotated.session, rotated.refreshToken);
    } catch (error) {
      if (error instanceof RotationConflictError) {
        throw AppError.unauthorized(
          ErrorCode.RefreshConflict,
          'Session was refreshed by another request; retry',
        );
      }
      throw error;
    }
  }

  /**
   * Ends the current login. Identified by the refresh cookie when present,
   * otherwise by the bearer token (even an expired one: revoking is harmless,
   * and an expired access token must not leave the user unable to log out).
   * Always succeeds.
   */
  async logout(
    refreshToken: string | null,
    bearerToken: string | null,
  ): Promise<void> {
    let familyId: string | null = null;

    if (refreshToken && refreshToken.length <= 256) {
      familyId =
        (await this.sessionsService.findByRefreshToken(refreshToken))
          ?.familyId ?? null;
    }
    if (!familyId && bearerToken) {
      const payload = await this.verifyAccessToken(bearerToken, {
        ignoreExpiration: true,
      });
      if (payload) {
        familyId =
          (await this.sessionsService.findById(payload.sid))?.familyId ?? null;
      }
    }
    if (familyId) {
      await this.sessionsService.revokeFamily(
        familyId,
        RevocationReason.Logout,
      );
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessionsService.revokeAllForUser(
      userId,
      RevocationReason.LogoutAll,
    );
  }

  // --- per-request access token check -------------------------------------

  /**
   * Called by `JwtStrategy` after the signature, issuer, audience and expiry
   * of the access token were verified. Confirms in one query that the session
   * is live and the account usable, so revocation and deactivation take
   * effect on the next request rather than at token expiry.
   */
  async validateAccessToken(
    payload: AccessTokenPayload,
  ): Promise<AuthenticatedUser> {
    if (
      payload.type !== 'access' ||
      typeof payload.sid !== 'string' ||
      typeof payload.sub !== 'string'
    ) {
      throw AppError.unauthorized(
        ErrorCode.Unauthenticated,
        'Invalid access token',
      );
    }

    const session = await this.sessionsService.findWithUser(payload.sid);
    if (
      !session ||
      session.userId !== payload.sub ||
      !SessionsService.isUsable(session) ||
      !session.user.isActive
    ) {
      throw sessionRevoked();
    }

    return {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      sessionId: session.id,
      familyId: session.familyId,
    };
  }

  // --- email verification ---------------------------------------------------

  /**
   * Always resolves the same way whether or not the email exists, is already
   * verified, or is in cooldown, so it cannot be used to probe accounts.
   */
  async resendVerification(email: string): Promise<void> {
    const user = await this.usersService.findRecordByEmail(email);
    if (!user || !user.isActive || user.emailVerifiedAt !== null) return;
    await this.sendVerificationEmail(user);
  }

  async confirmEmail(token: string): Promise<void> {
    const consumed = await this.authTokens.consume(
      token,
      AuthTokenType.EMAIL_VERIFICATION,
    );
    if (!consumed) {
      throw AppError.badRequest(
        ErrorCode.InvalidToken,
        'This link is invalid or has expired',
      );
    }
    await this.usersService.markEmailVerified(consumed.userId);
    this.logger.log(`User ${consumed.userId} verified their email`);
  }

  // --- password reset & change ---------------------------------------------

  /** Same response for every email, existing or not. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findRecordByEmail(email);
    if (!user || !user.isActive) return;

    const token = await this.authTokens.issue(
      user.id,
      AuthTokenType.PASSWORD_RESET,
    );
    if (!token) return; // cooldown: a recent email is still valid

    this.mail.dispatch(
      () => this.mail.sendPasswordReset(user.email, user.name, token),
      'password-reset',
    );
  }

  /**
   * Consumes the reset token and, in the same transaction, stores the new
   * password, clears any lockout, marks the email verified (the link proved
   * inbox access) and revokes every session. Does not log the user in.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    // Hash outside the transaction: Argon2 is slow and must not hold locks.
    const passwordHash = await this.passwordHasher.hash(dto.newPassword);

    const user = await this.usersService.transaction(async (tx) => {
      const consumed = await this.authTokens.consume(
        dto.token,
        AuthTokenType.PASSWORD_RESET,
        tx,
      );
      if (!consumed) {
        throw AppError.badRequest(
          ErrorCode.InvalidToken,
          'This link is invalid or has expired',
        );
      }
      const updated = await this.usersService.applyNewPassword(
        consumed.userId,
        passwordHash,
        { markEmailVerified: true },
        tx,
      );
      await this.sessionsService.revokeAllForUser(
        consumed.userId,
        RevocationReason.PasswordReset,
        tx,
      );
      await this.authTokens.invalidateAll(
        consumed.userId,
        AuthTokenType.PASSWORD_RESET,
        tx,
      );
      return updated;
    });

    this.logger.log(
      `User ${user.id} reset their password; all sessions revoked`,
    );
    this.mail.dispatch(
      () => this.mail.sendPasswordChanged(user.email, user.name),
      'password-changed',
    );
  }

  /**
   * Changes the password of the signed-in user after re-verifying the current
   * one. Other logins are revoked; the current one stays signed in.
   */
  async changePassword(
    actor: AuthenticatedUser,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.usersService.findRecordById(actor.id);
    if (!user) throw sessionRevoked();
    if (!user.passwordHash) {
      throw AppError.badRequest(
        ErrorCode.PasswordNotSet,
        'This account has no password yet; use "forgot password" to set one',
      );
    }

    const ok = await this.passwordHasher.verify(
      user.passwordHash,
      dto.currentPassword,
    );
    if (!ok) {
      await this.usersService.recordFailedLogin(user.id);
      throw AppError.unauthorized(
        ErrorCode.InvalidCredentials,
        'Current password is incorrect',
      );
    }
    if (dto.currentPassword === dto.newPassword) {
      throw AppError.badRequest(
        ErrorCode.PasswordUnchanged,
        'The new password must differ from the current one',
      );
    }

    const passwordHash = await this.passwordHasher.hash(dto.newPassword);
    await this.usersService.transaction(async (tx) => {
      await this.usersService.applyNewPassword(
        user.id,
        passwordHash,
        { markEmailVerified: false },
        tx,
      );
      await this.sessionsService.revokeAllForUserExceptFamily(
        user.id,
        actor.familyId,
        RevocationReason.PasswordChanged,
        tx,
      );
      await this.authTokens.invalidateAll(
        user.id,
        AuthTokenType.PASSWORD_RESET,
        tx,
      );
    });

    this.logger.log(
      `User ${user.id} changed their password; other sessions revoked`,
    );
    this.mail.dispatch(
      () => this.mail.sendPasswordChanged(user.email, user.name),
      'password-changed',
    );
  }

  // --- profile & sessions ----------------------------------------------------

  async getProfile(userId: string): Promise<UserEntity> {
    const user = await this.usersService.findRecordById(userId);
    if (!user) throw sessionRevoked();
    return new UserEntity(user);
  }

  async listSessions(actor: AuthenticatedUser): Promise<SessionDto[]> {
    const sessions = await this.sessionsService.listActiveForUser(actor.id);
    return sessions.map((session) => new SessionDto(session, actor.familyId));
  }

  /**
   * Revokes one of the caller's logins. Missing, foreign and already-revoked
   * ids all answer 404, so the endpoint reveals nothing about other users.
   * Returns whether the revoked login is the caller's own.
   */
  async revokeSession(
    actor: AuthenticatedUser,
    sessionId: string,
  ): Promise<{ wasCurrent: boolean }> {
    const session = await this.sessionsService.findById(sessionId);
    if (
      !session ||
      session.userId !== actor.id ||
      !SessionsService.isUsable(session)
    ) {
      throw AppError.notFound(ErrorCode.SessionNotFound, 'Session not found');
    }
    await this.sessionsService.revokeFamily(
      session.familyId,
      RevocationReason.UserRevoked,
    );
    return { wasCurrent: session.familyId === actor.familyId };
  }

  // --- internals ---------------------------------------------------------------

  private async handleRevokedRefresh(
    session: Session,
    now: number,
  ): Promise<never> {
    const revokedAt = session.revokedAt?.getTime() ?? 0;
    const graceMs = this.authConfig().refreshReuseGraceMs;

    if (session.revokedReason === RevocationReason.Rotated) {
      if (now - revokedAt <= graceMs) {
        throw AppError.unauthorized(
          ErrorCode.RefreshConflict,
          'Session was refreshed by another request; retry',
        );
      }
      const revoked = await this.sessionsService.revokeFamily(
        session.familyId,
        RevocationReason.ReuseDetected,
      );
      this.logger.warn(
        `Refresh token reuse detected for user ${session.userId} (family ${session.familyId}); revoked ${revoked} session(s)`,
      );
    }
    throw sessionRevoked();
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const token = await this.authTokens.issue(
      user.id,
      AuthTokenType.EMAIL_VERIFICATION,
    );
    if (!token) return;
    this.mail.dispatch(
      () => this.mail.sendEmailVerification(user.email, user.name, token),
      'email-verification',
    );
  }

  private async buildIssued(
    user: User,
    session: Session,
    refreshToken: string,
  ): Promise<IssuedAuth> {
    const auth = this.authConfig();
    const payload: AccessTokenPayload = {
      sub: user.id,
      sid: session.id,
      role: user.role,
      type: 'access',
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: auth.accessSecret,
      expiresIn: auth.accessTtlSeconds,
      issuer: auth.issuer,
      audience: auth.audience,
      algorithm: 'HS256',
    });

    return {
      result: new AuthResultDto(
        accessToken,
        auth.accessTtlSeconds,
        new UserEntity(user),
      ),
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  private async verifyAccessToken(
    token: string,
    options: { ignoreExpiration: boolean },
  ): Promise<AccessTokenPayload | null> {
    const auth = this.authConfig();
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        {
          secret: auth.accessSecret,
          issuer: auth.issuer,
          audience: auth.audience,
          algorithms: ['HS256'],
          ignoreExpiration: options.ignoreExpiration,
        },
      );
      return payload.type === 'access' ? payload : null;
    } catch {
      return null;
    }
  }

  private authConfig(): AppConfiguration['auth'] {
    return this.config.get('auth', { infer: true });
  }
}
