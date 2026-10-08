import { Injectable } from '@nestjs/common';

import {
  type AddonPackage,
  type BillingAccount,
  type Plan,
  type PlanPackage,
  Prisma,
  type Subscription,
  type SubscriptionEvent,
  type TokenBatch,
  type TokenLedgerEntry,
} from '../generated/prisma/client';
import {
  SubscriptionStatus,
  type TokenBatchSource,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type DbClient = Prisma.TransactionClient;

export type SubscriptionWithPlan = Subscription & {
  plan: Plan;
  package: PlanPackage | null;
  scheduledPackage: PlanPackage | null;
};

export type PackageWithPlan = PlanPackage & { plan: Plan };

const LIVE_STATUSES = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE];

const withPlan = { plan: true, package: true, scheduledPackage: true } as const;

/**
 * Data access for every billing table. Methods take an optional transaction
 * client so services can compose them atomically.
 */
@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Interactive transaction. Billing writes are short, but Stripe-driven
   * work can queue behind a user's row lock, so the wait is generous.
   */
  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { maxWait: 10_000, timeout: 20_000 });
  }

  // --- catalog -------------------------------------------------------------

  listPlans(
    includeInactive: boolean,
  ): Promise<(Plan & { packages: PlanPackage[] })[]> {
    return this.prisma.plan.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: {
        packages: {
          where: includeInactive ? {} : { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  findPlan(id: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { id } });
  }

  updatePlan(id: string, data: Prisma.PlanUpdateInput): Promise<Plan> {
    return this.prisma.plan.update({ where: { id }, data });
  }

  findPackage(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<PackageWithPlan | null> {
    return db.planPackage.findUnique({
      where: { id },
      include: { plan: true },
    });
  }

  findPackageByPriceId(
    priceId: string,
    db: DbClient = this.prisma,
  ): Promise<PackageWithPlan | null> {
    return db.planPackage.findFirst({
      where: {
        OR: [
          { stripePriceIdMonthly: priceId },
          { stripePriceIdYearly: priceId },
        ],
      },
      include: { plan: true },
    });
  }

  createPackage(
    data: Prisma.PlanPackageUncheckedCreateInput,
  ): Promise<PlanPackage> {
    return this.prisma.planPackage.create({ data });
  }

  updatePackage(
    id: string,
    data: Prisma.PlanPackageUncheckedUpdateInput,
  ): Promise<PlanPackage> {
    return this.prisma.planPackage.update({ where: { id }, data });
  }

  listAddons(includeInactive: boolean): Promise<AddonPackage[]> {
    return this.prisma.addonPackage.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  findAddon(id: string): Promise<AddonPackage | null> {
    return this.prisma.addonPackage.findUnique({ where: { id } });
  }

  createAddon(data: Prisma.AddonPackageCreateInput): Promise<AddonPackage> {
    return this.prisma.addonPackage.create({ data });
  }

  updateAddon(
    id: string,
    data: Prisma.AddonPackageUpdateInput,
  ): Promise<AddonPackage> {
    return this.prisma.addonPackage.update({ where: { id }, data });
  }

  // --- accounts --------------------------------------------------------------

  findAccount(
    userId: string,
    db: DbClient = this.prisma,
  ): Promise<BillingAccount | null> {
    return db.billingAccount.findUnique({ where: { userId } });
  }

  /** Inserts the account if missing. Returns true only for the caller that created it. */
  async createAccountIfMissing(userId: string, db: DbClient): Promise<boolean> {
    const { count } = await db.billingAccount.createMany({
      data: [{ userId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  /**
   * Row lock on the user's billing account. Every token or subscription
   * mutation takes it first, which serialises them per user.
   */
  async lockAccount(userId: string, db: DbClient): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM billing_accounts WHERE user_id = ${userId}::uuid FOR UPDATE
    `;
    return rows.length === 1;
  }

  updateAccount(
    userId: string,
    data: Prisma.BillingAccountUpdateInput,
    db: DbClient = this.prisma,
  ): Promise<BillingAccount> {
    return db.billingAccount.update({ where: { userId }, data });
  }

  async userExists(
    userId: string,
    db: DbClient = this.prisma,
  ): Promise<boolean> {
    return (await db.user.count({ where: { id: userId } })) === 1;
  }

  /** Sets the Stripe customer only if none is stored yet. */
  async setCustomerIfMissing(
    userId: string,
    stripeCustomerId: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.billingAccount.updateMany({
      where: { userId, stripeCustomerId: null },
      data: { stripeCustomerId },
    });
  }

  findAccountByCustomer(
    stripeCustomerId: string,
    db: DbClient = this.prisma,
  ): Promise<BillingAccount | null> {
    return db.billingAccount.findUnique({ where: { stripeCustomerId } });
  }

  // --- subscriptions ---------------------------------------------------------

  findLiveSubscription(
    userId: string,
    db: DbClient = this.prisma,
  ): Promise<SubscriptionWithPlan | null> {
    return db.subscription.findFirst({
      where: { userId, status: { in: LIVE_STATUSES } },
      include: withPlan,
    });
  }

  findByStripeId(
    stripeSubscriptionId: string,
    db: DbClient = this.prisma,
  ): Promise<SubscriptionWithPlan | null> {
    return db.subscription.findUnique({
      where: { stripeSubscriptionId },
      include: withPlan,
    });
  }

  createSubscription(
    data: Prisma.SubscriptionUncheckedCreateInput,
    db: DbClient,
  ): Promise<Subscription> {
    return db.subscription.create({ data });
  }

  updateSubscription(
    id: string,
    data: Prisma.SubscriptionUncheckedUpdateInput,
    db: DbClient = this.prisma,
  ): Promise<Subscription> {
    return db.subscription.update({ where: { id }, data });
  }

  /** Planned per-plan counts of live subscriptions, for the admin dashboard. */
  async countLiveByPlan(): Promise<Array<{ planId: string; count: number }>> {
    const rows = await this.prisma.subscription.groupBy({
      by: ['planId'],
      where: { status: { in: LIVE_STATUSES } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ planId: row.planId, count: row._count._all }));
  }

  liveSubscriptionsFor(userIds: string[]): Promise<SubscriptionWithPlan[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.subscription.findMany({
      where: { userId: { in: userIds }, status: { in: LIVE_STATUSES } },
      include: withPlan,
    });
  }

  // --- token batches ---------------------------------------------------------

  /**
   * Batches with tokens left that are usable now, in drain order: soonest
   * expiry first, then non-expiring oldest first.
   */
  async usableBatches(
    userId: string,
    now: Date,
    db: DbClient = this.prisma,
  ): Promise<TokenBatch[]> {
    const batches = await db.tokenBatch.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: [
        { expiresAt: { sort: 'asc', nulls: 'last' } },
        { grantedAt: 'asc' },
        { id: 'asc' },
      ],
    });
    return batches.filter((batch) => batch.tokensUsed < batch.tokensGranted);
  }

  async balance(
    userId: string,
    now: Date,
    db: DbClient = this.prisma,
  ): Promise<number> {
    const rows = await db.$queryRaw<Array<{ balance: bigint | null }>>`
      SELECT SUM(tokens_granted - tokens_used) AS balance
      FROM token_batches
      WHERE user_id = ${userId}::uuid AND (expires_at IS NULL OR expires_at > ${now})
    `;
    return Number(rows[0]?.balance ?? 0);
  }

  async balancesFor(
    userIds: string[],
    now: Date,
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string; balance: bigint }>
    >`
      SELECT user_id, SUM(tokens_granted - tokens_used) AS balance
      FROM token_batches
      WHERE user_id = ANY(${userIds}::uuid[]) AND (expires_at IS NULL OR expires_at > ${now})
      GROUP BY user_id
    `;
    return new Map(rows.map((row) => [row.user_id, Number(row.balance)]));
  }

  createBatch(
    data: Prisma.TokenBatchUncheckedCreateInput,
    db: DbClient,
  ): Promise<TokenBatch> {
    return db.tokenBatch.create({ data });
  }

  /** Conditional increment: refuses to exceed the batch, whatever ran concurrently. */
  async consumeFromBatch(
    batchId: string,
    amount: number,
    db: DbClient,
  ): Promise<boolean> {
    const updated = await db.$executeRaw`
      UPDATE token_batches SET tokens_used = tokens_used + ${amount}
      WHERE id = ${batchId}::uuid AND tokens_used + ${amount} <= tokens_granted
    `;
    return updated === 1;
  }

  /**
   * Starts the expiry clock on the user's current-period batches: those with
   * a scheduled expiry but no active one. Batches without a schedule (e.g.
   * permanent admin grants) are left alone.
   */
  async startScheduledExpiry(userId: string, db: DbClient): Promise<number> {
    return db.$executeRaw`
      UPDATE token_batches SET expires_at = scheduled_expiry_at
      WHERE user_id = ${userId}::uuid AND expires_at IS NULL AND scheduled_expiry_at IS NOT NULL
    `;
  }

  /** Moves unexpired trial tokens into the paid period: they now expire with it. */
  async carryTrialIntoPeriod(
    userId: string,
    scheduledExpiryAt: Date,
    now: Date,
    db: DbClient,
  ): Promise<number> {
    const { count } = await db.tokenBatch.updateMany({
      where: {
        userId,
        source: 'TRIAL' satisfies TokenBatchSource,
        expiresAt: { gt: now },
      },
      data: { expiresAt: null, scheduledExpiryAt },
    });
    return count;
  }

  listBatches(userId: string, take = 100): Promise<TokenBatch[]> {
    return this.prisma.tokenBatch.findMany({
      where: { userId },
      orderBy: [{ grantedAt: 'desc' }],
      take,
    });
  }

  findBatch(id: string): Promise<TokenBatch | null> {
    return this.prisma.tokenBatch.findUnique({ where: { id } });
  }

  updateBatch(
    id: string,
    data: Prisma.TokenBatchUpdateInput,
  ): Promise<TokenBatch> {
    return this.prisma.tokenBatch.update({ where: { id }, data });
  }

  // --- ledger & history ----------------------------------------------------------

  findLedgerEntry(
    idempotencyKey: string,
    db: DbClient = this.prisma,
  ): Promise<TokenLedgerEntry | null> {
    return db.tokenLedgerEntry.findUnique({ where: { idempotencyKey } });
  }

  createLedgerEntry(
    data: Prisma.TokenLedgerEntryUncheckedCreateInput,
    db: DbClient,
  ): Promise<TokenLedgerEntry> {
    return db.tokenLedgerEntry.create({ data });
  }

  async ledgerPage(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ items: TokenLedgerEntry[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.tokenLedgerEntry.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.tokenLedgerEntry.count({ where: { userId } }),
    ]);
    return { items, total };
  }

  async usageSince(since: Date): Promise<number> {
    const result = await this.prisma.tokenLedgerEntry.aggregate({
      where: { amount: { lt: 0 }, createdAt: { gte: since } },
      _sum: { amount: true },
    });
    return Math.abs(result._sum.amount ?? 0);
  }

  createEvent(
    data: Prisma.SubscriptionEventUncheckedCreateInput,
    db: DbClient,
  ): Promise<SubscriptionEvent> {
    return db.subscriptionEvent.create({ data });
  }

  async eventPage(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ items: SubscriptionEvent[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.subscriptionEvent.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.subscriptionEvent.count({ where: { userId } }),
    ]);
    return { items, total };
  }

  // --- Stripe webhook idempotency ------------------------------------------------

  /**
   * Claims a Stripe event inside the caller's transaction. A concurrent
   * delivery of the same event blocks on the primary key until the first
   * commits, then sees a conflict. Returns false if already processed.
   */
  async claimStripeEvent(
    id: string,
    type: string,
    db: DbClient,
  ): Promise<boolean> {
    const { count } = await db.stripeEvent.createMany({
      data: [{ id, type }],
      skipDuplicates: true,
    });
    return count === 1;
  }
}

export function isUniqueViolationOn(error: unknown, target: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes(target);
}
