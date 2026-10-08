import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { AppConfiguration } from '../../config/configuration';
import type { Prisma, Session, User } from '../../generated/prisma/client';
import { generateOpaqueToken, sha256Hex } from '../crypto.util';
import type { SessionContext } from '../auth.types';
import { SessionsRepository } from './sessions.repository';

type DbClient = Prisma.TransactionClient;

/** Why a session stopped being valid. Recorded for auditing. */
export const RevocationReason = {
  Logout: 'logout',
  LogoutAll: 'logout_all',
  Rotated: 'rotated',
  ReuseDetected: 'reuse_detected',
  PasswordChanged: 'password_changed',
  PasswordReset: 'password_reset',
  UserRevoked: 'user_revoked',
  AdminDeactivated: 'admin_deactivated',
  RoleChanged: 'role_changed',
  SessionLimit: 'session_limit',
  AccountLinked: 'account_linked',
  AccountUnavailable: 'account_unavailable',
  AbsoluteExpiry: 'absolute_expiry',
} as const;

export type RevocationReason =
  (typeof RevocationReason)[keyof typeof RevocationReason];

/** Thrown when another request rotated the same session first. */
export class RotationConflictError extends Error {
  constructor() {
    super('Session was rotated concurrently');
    this.name = 'RotationConflictError';
  }
}

export interface IssuedSession {
  session: Session;
  /** Raw opaque refresh token. Only its hash is persisted. */
  refreshToken: string;
}

/**
 * Server-side session store backing the refresh tokens.
 *
 * Refresh tokens are 256-bit random values, stored only as SHA-256 hashes.
 * Every refresh rotates the token; all generations descending from one login
 * share a `familyId`, so a replayed old token can revoke the whole chain.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * Starts a new session family for a fresh login. Enforces the per-user cap
   * by revoking the least recently used sessions, in the same transaction.
   */
  issue(userId: string, context: SessionContext): Promise<IssuedSession> {
    const auth = this.config.get('auth', { infer: true });

    return this.sessions.transaction(async (tx) => {
      const now = new Date();
      const activeIds = await this.sessions.listActiveIdsOldestFirst(
        userId,
        now,
        tx,
      );
      const excess = activeIds.length - auth.maxSessionsPerUser + 1;
      if (excess > 0) {
        await this.sessions.revokeMany(
          { id: { in: activeIds.slice(0, excess) } },
          RevocationReason.SessionLimit,
          tx,
        );
      }

      return this.insert(
        { userId, familyId: randomUUID(), authenticatedAt: now, context },
        tx,
      );
    });
  }

  /**
   * Replaces `current` with its successor. The old row is revoked with a
   * conditional update, so of two concurrent rotations only one can win; the
   * loser gets {@link RotationConflictError}.
   */
  rotate(current: Session, context: SessionContext): Promise<IssuedSession> {
    return this.sessions.transaction(async (tx) => {
      const won = await this.sessions.revokeIfActive(
        current.id,
        RevocationReason.Rotated,
        tx,
      );
      if (!won) throw new RotationConflictError();

      const issued = await this.insert(
        {
          userId: current.userId,
          familyId: current.familyId,
          authenticatedAt: current.authenticatedAt,
          context,
        },
        tx,
      );
      await this.sessions.setReplacedBy(current.id, issued.session.id, tx);
      return issued;
    });
  }

  findByRefreshToken(refreshToken: string): Promise<Session | null> {
    return this.sessions.findByTokenHash(sha256Hex(refreshToken));
  }

  findById(sessionId: string): Promise<Session | null> {
    return this.sessions.findById(sessionId);
  }

  findWithUser(sessionId: string): Promise<(Session & { user: User }) | null> {
    return this.sessions.findWithUser(sessionId);
  }

  listActiveForUser(userId: string): Promise<Session[]> {
    return this.sessions.listActiveForUser(userId, new Date());
  }

  /** Ends one login: every generation in the family. */
  async revokeFamily(
    familyId: string,
    reason: RevocationReason,
    db?: DbClient,
  ): Promise<number> {
    return this.sessions.revokeMany({ familyId }, reason, db);
  }

  async revokeAllForUser(
    userId: string,
    reason: RevocationReason,
    db?: DbClient,
  ): Promise<number> {
    const count = await this.sessions.revokeMany({ userId }, reason, db);
    if (count > 0) {
      this.logger.log(
        `Revoked ${count} session(s) for user ${userId}: ${reason}`,
      );
    }
    return count;
  }

  /** Revokes every session of the user except those in `keepFamilyId`. */
  revokeAllForUserExceptFamily(
    userId: string,
    keepFamilyId: string,
    reason: RevocationReason,
    db?: DbClient,
  ): Promise<number> {
    return this.sessions.revokeMany(
      { userId, familyId: { not: keepFamilyId } },
      reason,
      db,
    );
  }

  /** Deletes sessions whose refresh token expired more than a day ago. */
  pruneExpired(now: Date = new Date()): Promise<number> {
    return this.sessions.deleteExpiredBefore(
      new Date(now.getTime() - 86_400_000),
    );
  }

  /** Expiry of the family: start of the login plus the absolute lifetime. */
  absoluteExpiry(session: Pick<Session, 'authenticatedAt'>): Date {
    const auth = this.config.get('auth', { infer: true });
    return new Date(
      session.authenticatedAt.getTime() + auth.sessionAbsoluteTtlMs,
    );
  }

  static isUsable(session: Session, now: Date = new Date()): boolean {
    return (
      session.revokedAt === null && session.expiresAt.getTime() > now.getTime()
    );
  }

  private async insert(
    params: {
      userId: string;
      familyId: string;
      authenticatedAt: Date;
      context: SessionContext;
    },
    tx: DbClient,
  ): Promise<IssuedSession> {
    const auth = this.config.get('auth', { infer: true });
    const refreshToken = generateOpaqueToken();
    const now = Date.now();

    // A rotated token never outlives the login it descends from.
    const expiresAt = new Date(
      Math.min(
        now + auth.refreshTtlMs,
        params.authenticatedAt.getTime() + auth.sessionAbsoluteTtlMs,
      ),
    );

    const session = await this.sessions.create(
      {
        id: randomUUID(),
        userId: params.userId,
        familyId: params.familyId,
        refreshTokenHash: sha256Hex(refreshToken),
        authenticatedAt: params.authenticatedAt,
        expiresAt,
        userAgent: truncate(params.context.userAgent, 512),
        ipAddress: truncate(params.context.ipAddress, 64),
      },
      tx,
    );

    return { session, refreshToken };
  }
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
