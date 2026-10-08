import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../../config/configuration';
import type { AuthToken, Prisma } from '../../generated/prisma/client';
import { AuthTokenType } from '../../generated/prisma/enums';
import { generateOpaqueToken, sha256Hex } from '../crypto.util';
import { AuthTokensRepository } from './auth-tokens.repository';

type DbClient = Prisma.TransactionClient;

/** Upper bound on a raw token we bother hashing; real ones are 43 chars. */
const MAX_TOKEN_LENGTH = 256;

/**
 * Single-use, expiring secrets sent by email (verification, password reset).
 *
 * The raw token exists only in the email; the database holds its SHA-256.
 */
@Injectable()
export class AuthTokensService {
  constructor(
    private readonly tokens: AuthTokensRepository,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * Issues a new token, invalidating any outstanding one of the same type so
   * only the most recent email works. Returns `null` when the previous token
   * was issued within the cooldown, which stops a caller from using us to
   * flood someone's inbox.
   */
  async issue(userId: string, type: AuthTokenType): Promise<string | null> {
    const auth = this.config.get('auth', { infer: true });

    const lastIssuedAt = await this.tokens.findLatestCreatedAt(userId, type);
    if (
      lastIssuedAt &&
      Date.now() - lastIssuedAt.getTime() < auth.emailCooldownMs
    ) {
      return null;
    }

    const ttlMs =
      type === AuthTokenType.PASSWORD_RESET
        ? auth.passwordResetTtlMs
        : auth.emailVerificationTtlMs;
    const raw = generateOpaqueToken();

    await this.tokens.transaction(async (tx) => {
      await this.tokens.invalidateOutstanding(userId, type, tx);
      await this.tokens.create(
        {
          userId,
          type,
          tokenHash: sha256Hex(raw),
          expiresAt: new Date(Date.now() + ttlMs),
        },
        tx,
      );
    });

    return raw;
  }

  /**
   * Consumes a token of the given type. Returns `null` for every failure
   * (unknown, wrong type, expired, already used) so callers answer them all
   * identically.
   */
  consume(
    raw: string,
    type: AuthTokenType,
    db?: DbClient,
  ): Promise<AuthToken | null> {
    if (!raw || raw.length > MAX_TOKEN_LENGTH) return Promise.resolve(null);
    return this.tokens.consume(sha256Hex(raw), type, new Date(), db);
  }

  invalidateAll(
    userId: string,
    type: AuthTokenType,
    db?: DbClient,
  ): Promise<number> {
    return this.tokens.invalidateOutstanding(userId, type, db);
  }

  /** Deletes tokens that expired or were used more than a day ago. */
  pruneStale(now: Date = new Date()): Promise<number> {
    return this.tokens.deleteStale(new Date(now.getTime() - 86_400_000));
  }
}
