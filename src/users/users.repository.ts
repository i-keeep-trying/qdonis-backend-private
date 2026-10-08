import { Injectable } from '@nestjs/common';

import type { Prisma, User } from '../generated/prisma/client';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** A client usable both inside and outside an interactive transaction. */
export type DbClient = Prisma.TransactionClient;

/**
 * Data access for users. The only place Prisma is called for the `users`
 * table.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in one interactive transaction. Repositories accept the
   * resulting client so a service can compose several of them atomically.
   */
  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  findById(id: string, db: DbClient = this.prisma): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  /** Emails are stored lower-cased; callers must normalise before lookup. */
  findByEmail(email: string, db: DbClient = this.prisma): Promise<User | null> {
    return db.user.findUnique({ where: { email } });
  }

  create(
    data: Prisma.UserCreateInput,
    db: DbClient = this.prisma,
  ): Promise<User> {
    return db.user.create({ data });
  }

  update(
    id: string,
    data: Prisma.UserUpdateInput,
    db: DbClient = this.prisma,
  ): Promise<User> {
    return db.user.update({ where: { id }, data });
  }

  delete(id: string, db: DbClient = this.prisma): Promise<User> {
    return db.user.delete({ where: { id } });
  }

  /**
   * One transaction so `total` cannot drift from `items` under concurrent
   * writes.
   */
  async paginate(
    skip: number,
    take: number,
  ): Promise<{ items: User[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.user.count(),
    ]);
    return { items, total };
  }

  /**
   * True while Stripe would keep charging the user: a live Stripe
   * subscription that is not already set to end at period end.
   */
  async hasRenewingPaidSubscription(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<boolean> {
    const count = await db.subscription.count({
      where: {
        userId: id,
        stripeSubscriptionId: { not: null },
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        cancelAtPeriodEnd: false,
      },
    });
    return count > 0;
  }

  /** Case-insensitive search on email and name, paginated consistently. */
  async search(
    term: string | undefined,
    skip: number,
    take: number,
  ): Promise<{ items: User[]; total: number }> {
    const where: Prisma.UserWhereInput = term
      ? {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  async countAll(): Promise<{
    total: number;
    active: number;
    verified: number;
    newLast30Days: number;
  }> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [total, active, verified, newLast30Days] =
      await this.prisma.$transaction([
        this.prisma.user.count(),
        this.prisma.user.count({ where: { isActive: true } }),
        this.prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
        this.prisma.user.count({ where: { createdAt: { gte: since } } }),
      ]);
    return { total, active, verified, newLast30Days };
  }

  /**
   * Locks every active admin row and returns their ids. Taking row locks makes
   * concurrent "demote/deactivate/delete an admin" transactions serialise, so
   * two admins cannot remove each other and leave the system with none.
   */
  async lockActiveAdminIds(db: DbClient): Promise<string[]> {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE role = ${Role.ADMIN}::"role" AND is_active = true
      FOR UPDATE
    `;
    return rows.map((row) => row.id);
  }

  /**
   * Atomic `failed_login_attempts + 1`. Returns the new count, so concurrent
   * failures cannot overwrite each other's increments.
   */
  async incrementFailedLogins(id: string): Promise<number> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    return user.failedLoginAttempts;
  }

  /**
   * Locks the account if the counter is still at or above `threshold` and
   * resets it. Conditional, so only one of several concurrent failures applies
   * the lock. Returns whether this call locked the account.
   */
  async lockIfThresholdReached(
    id: string,
    threshold: number,
    lockedUntil: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id, failedLoginAttempts: { gte: threshold } },
      data: { lockedUntil, failedLoginAttempts: 0 },
    });
    return count > 0;
  }

  recordSuccessfulLogin(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }

  /**
   * Burns every outstanding emailed token for the user. Used when the email
   * address changes, so a link sent to the old address cannot verify the new
   * one or reset its password.
   */
  async invalidateEmailTokens(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.authToken.updateMany({
      where: { userId: id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Sets `email_verified_at` only if still null; idempotent. */
  async markEmailVerified(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.user.updateMany({
      where: { id, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }
}
