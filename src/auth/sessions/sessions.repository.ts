import { Injectable } from '@nestjs/common';

import type { Prisma, Session, User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type DbClient = Prisma.TransactionClient;

export interface NewSessionRow {
  id: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  authenticatedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

/** Data access for `sessions`. The only place Prisma touches that table. */
@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(row: NewSessionRow, db: DbClient = this.prisma): Promise<Session> {
    return db.session.create({ data: row });
  }

  findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  findByTokenHash(refreshTokenHash: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { refreshTokenHash } });
  }

  /** One round trip for the per-request access-token check. */
  findWithUser(id: string): Promise<(Session & { user: User }) | null> {
    return this.prisma.session.findUnique({
      where: { id },
      include: { user: true },
    });
  }

  listActiveForUser(userId: string, now: Date): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  /** Active session ids for a user, least recently used first. */
  async listActiveIdsOldestFirst(
    userId: string,
    now: Date,
    db: DbClient,
  ): Promise<string[]> {
    const rows = await db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Revokes one session only if it is still live. Returns whether this call
   * did it — the basis of race-free rotation.
   */
  async revokeIfActive(
    id: string,
    reason: string,
    db: DbClient = this.prisma,
  ): Promise<boolean> {
    const { count } = await db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count > 0;
  }

  async setReplacedBy(
    id: string,
    replacedById: string,
    db: DbClient,
  ): Promise<void> {
    await db.session.update({ where: { id }, data: { replacedById } });
  }

  async revokeMany(
    where: Prisma.SessionWhereInput,
    reason: string,
    db: DbClient = this.prisma,
  ): Promise<number> {
    const { count } = await db.session.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /**
   * Deletes rows whose refresh token expired before `cutoff`.
   *
   * Revoked-but-unexpired rows are kept on purpose: their token still verifies
   * cryptographically, and the row is what lets a replay of it be recognised
   * as theft. Once the token itself has expired the row has no further use.
   */
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return count;
  }
}
