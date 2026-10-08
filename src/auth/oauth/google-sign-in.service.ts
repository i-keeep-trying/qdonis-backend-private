import { Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import type { User } from '../../generated/prisma/client';
import { OAuthProvider } from '../../generated/prisma/enums';
import { UsersService } from '../../users/users.service';
import { type IssuedAuth, AuthService } from '../auth.service';
import type { SessionContext } from '../auth.types';
import {
  RevocationReason,
  SessionsService,
} from '../sessions/sessions.service';
import type { GoogleProfile } from './google-oauth.client';
import { OAuthAccountsRepository } from './oauth-accounts.repository';

/**
 * Resolves a verified Google identity to a local user and starts a session.
 *
 * Linking rules:
 *  1. A Google account already linked (by `sub`) signs into its user.
 *  2. Otherwise, an existing user with the same (Google-verified) email gets
 *     the Google account linked. If that user had NOT verified the email, the
 *     account could have been pre-registered by someone else to hijack it, so
 *     the existing password is removed and all sessions are revoked: the
 *     Google holder becomes the sole owner.
 *  3. Otherwise a new, already-verified, passwordless user is created.
 */
@Injectable()
export class GoogleSignInService {
  private readonly logger = new Logger(GoogleSignInService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly oauthAccounts: OAuthAccountsRepository,
    private readonly sessionsService: SessionsService,
    private readonly authService: AuthService,
  ) {}

  async signIn(
    profile: GoogleProfile,
    context: SessionContext,
  ): Promise<IssuedAuth> {
    let user: User;
    try {
      user = await this.resolveUser(profile);
    } catch (error) {
      // Two first-time callbacks for the same person raced on a unique index;
      // the other one created the rows, so resolving again finds them.
      if (!isUniqueViolation(error)) throw error;
      user = await this.resolveUser(profile);
    }

    if (!user.isActive) {
      throw AppError.unauthorized(
        ErrorCode.AccountUnavailable,
        'This account is disabled',
      );
    }

    const fresh = await this.usersService.recordSuccessfulLogin(user.id);
    return this.authService.startSession(fresh, context);
  }

  private resolveUser(profile: GoogleProfile): Promise<User> {
    return this.usersService.transaction(async (tx) => {
      const linked = await this.oauthAccounts.findWithUser(
        OAuthProvider.GOOGLE,
        profile.subject,
        tx,
      );
      if (linked) {
        if (linked.email !== profile.email) {
          await this.oauthAccounts.updateEmail(linked.id, profile.email, tx);
        }
        return linked.user;
      }

      const existing = await this.usersService.findRecordByEmail(
        profile.email,
        tx,
      );
      if (existing) {
        const otherGoogle = await this.oauthAccounts.findForUser(
          existing.id,
          OAuthProvider.GOOGLE,
          tx,
        );
        if (otherGoogle) {
          // Same email, different Google subject (e.g. account recreated).
          throw AppError.conflict(
            ErrorCode.EmailTaken,
            'This email is linked to a different Google account',
          );
        }

        let user = existing;
        if (existing.emailVerifiedAt === null) {
          user = await this.usersService.updateRecord(
            existing.id,
            {
              emailVerifiedAt: new Date(),
              passwordHash: null,
              failedLoginAttempts: 0,
              lockedUntil: null,
            },
            tx,
          );
          await this.sessionsService.revokeAllForUser(
            existing.id,
            RevocationReason.AccountLinked,
            tx,
          );
          this.logger.warn(
            `Google sign-in claimed unverified account ${existing.id}; prior password removed and sessions revoked`,
          );
        }

        await this.oauthAccounts.create(
          {
            userId: user.id,
            provider: OAuthProvider.GOOGLE,
            providerAccountId: profile.subject,
            email: profile.email,
          },
          tx,
        );
        if (!user.avatarUrl && profile.picture) {
          user = await this.usersService.updateRecord(
            user.id,
            { avatarUrl: profile.picture },
            tx,
          );
        }
        this.logger.log(`Linked Google account to user ${user.id}`);
        return user;
      }

      const created = await this.usersService.insertRecord(
        {
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture,
          emailVerifiedAt: new Date(),
          passwordHash: null,
        },
        tx,
      );
      await this.oauthAccounts.create(
        {
          userId: created.id,
          provider: OAuthProvider.GOOGLE,
          providerAccountId: profile.subject,
          email: profile.email,
        },
        tx,
      );
      return created;
    });
  }
}
