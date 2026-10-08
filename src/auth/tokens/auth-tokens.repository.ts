import { Injectable } from '@nestjs/common';

import type { AuthToken, Prisma } from '../../generated/prisma/client';
import type { AuthTokenType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

type DbClient = Prisma.TransactionClient;

/** Data access for `auth_tokens`. */
@Injectable()
export class AuthTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(
    data: {
      userId: string;
      type: AuthTokenType;
      tokenHash: string;
      expiresAt: Date;
    },
    db: DbClient = this.prisma,
  ): Promise<AuthToken> {
    return db.authToken.create({ data });
  }

  /** Marks every outstanding token of `type` for the user as used. */
  async invalidateOutstanding(
    userId: string,
    type: AuthTokenType,
    db: DbClient = this.prisma,
  ): Promise<number> {
    const { count } = await db.authToken.updateMany({
      where: { userId, type, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count;
  }

  findLatestCreatedAt(
    userId: string,
    type: AuthTokenType,
  ): Promise<Date | null> {
    return this.prisma.authToken
      .findFirst({
        where: { userId, type },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      .then((row) => row?.createdAt ?? null);
  }

  /**
   * Single-use consumption. The conditional update means exactly one of N
   * concurrent attempts flips `consumed_at`; the rest see `count = 0`.
   */
  async consume(
    tokenHash: string,
    type: AuthTokenType,
    now: Date,
    db: DbClient = this.prisma,
  ): Promise<AuthToken | null> {
    const { count } = await db.authToken.updateMany({
      where: { tokenHash, type, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (count === 0) return null;
    return db.authToken.findUnique({ where: { tokenHash } });
  }

  async deleteStale(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.authToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }],
      },
    });
    return count;
  }
}
