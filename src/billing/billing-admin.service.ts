import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type {
  SubscriptionEvent,
  TokenBatch,
  TokenLedgerEntry,
} from '../generated/prisma/client';
import {
  PlanTier,
  SubscriptionStatus,
  TokenBatchSource,
} from '../generated/prisma/enums';
import { SettingsService } from '../settings/settings.service';
import {
  BillingRepository,
  type SubscriptionWithPlan,
} from './billing.repository';
import type {
  AdminAssignPlanDto,
  AdminBatchExpiryDto,
  AdminDeductTokensDto,
  AdminGrantTokensDto,
} from './dto/billing.dto';
import { SubscriptionsService } from './subscriptions.service';
import { addDays, addMonths, TokensService } from './tokens.service';

export interface UserBillingSummary {
  subscription: SubscriptionWithPlan | null;
  balance: number;
}

@Injectable()
export class BillingAdminService {
  private readonly logger = new Logger(BillingAdminService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly tokens: TokensService,
    private readonly subscriptions: SubscriptionsService,
    private readonly settings: SettingsService,
  ) {}

  /** Plan and balance for a page of users (two queries, no N+1). */
  async summaries(userIds: string[]): Promise<Map<string, UserBillingSummary>> {
    const [subs, balances] = await Promise.all([
      this.repository.liveSubscriptionsFor(userIds),
      this.repository.balancesFor(userIds, new Date()),
    ]);
    const byUser = new Map(subs.map((sub) => [sub.userId, sub]));
    return new Map(
      userIds.map((id) => [
        id,
        {
          subscription: byUser.get(id) ?? null,
          balance: balances.get(id) ?? 0,
        },
      ]),
    );
  }

  async detail(userId: string): Promise<{
    subscription: SubscriptionWithPlan | null;
    balance: number;
    batches: TokenBatch[];
    ledger: TokenLedgerEntry[];
    events: SubscriptionEvent[];
  }> {
    await this.subscriptions.ensureAccount(userId);
    const [subscription, balance, batches, ledger, events] = await Promise.all([
      this.repository.findLiveSubscription(userId),
      this.tokens.balance(userId),
      this.repository.listBatches(userId),
      this.repository.ledgerPage(userId, 0, 50),
      this.repository.eventPage(userId, 0, 50),
    ]);
    return {
      subscription,
      balance,
      batches,
      ledger: ledger.items,
      events: events.items,
    };
  }

  async grantTokens(
    actorId: string,
    userId: string,
    dto: AdminGrantTokensDto,
  ): Promise<{ balance: number }> {
    await this.subscriptions.ensureAccount(userId);
    const balance = await this.repository.transaction(async (tx) => {
      await this.repository.lockAccount(userId, tx);
      const live = await this.repository.findLiveSubscription(userId, tx);
      await this.tokens.grant(
        {
          userId,
          amount: dto.amount,
          source: TokenBatchSource.ADMIN_GRANT,
          idempotencyKey: `admin-grant:${randomUUID()}`,
          reason: 'admin_grant',
          subscriptionId: live?.id ?? null,
          expiresAt: dto.expiresInDays
            ? addDays(new Date(), dto.expiresInDays)
            : null,
          note: dto.note,
          metadata: { grantedBy: actorId },
        },
        tx,
      );
      await this.repository.createEvent(
        {
          userId,
          subscriptionId: live?.id ?? null,
          type: 'admin_grant',
          tokensDelta: dto.amount,
          metadata: {
            grantedBy: actorId,
            note: dto.note,
            expiresInDays: dto.expiresInDays ?? null,
          },
        },
        tx,
      );
      return this.tokens.balance(userId, tx);
    });
    this.logger.log(
      `Admin ${actorId} granted ${dto.amount} tokens to ${userId}`,
    );
    return { balance };
  }

  /** Removes tokens (soonest-expiring first). Refuses to go below zero. */
  async deductTokens(
    actorId: string,
    userId: string,
    dto: AdminDeductTokensDto,
  ): Promise<{ balance: number }> {
    await this.subscriptions.ensureAccount(userId);
    const result = await this.tokens.consume({
      userId,
      amount: dto.amount,
      idempotencyKey: `admin-deduct:${randomUUID()}`,
      reason: 'admin_deduction',
      metadata: { deductedBy: actorId, note: dto.note },
    });
    this.logger.log(
      `Admin ${actorId} deducted ${dto.amount} tokens from ${userId}`,
    );
    return { balance: result.balance };
  }

  async updateBatchExpiry(
    actorId: string,
    batchId: string,
    dto: AdminBatchExpiryDto,
  ): Promise<TokenBatch> {
    const batch = await this.repository.findBatch(batchId);
    if (!batch)
      throw AppError.notFound(ErrorCode.BatchNotFound, 'Token batch not found');

    const expiresAt = dto.expiresAt === null ? null : new Date(dto.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'expiresAt must be in the future',
      );
    }
    const updated = await this.repository.updateBatch(batchId, { expiresAt });
    this.logger.log(
      `Admin ${actorId} set expiry of batch ${batchId} to ${expiresAt?.toISOString() ?? 'never'}`,
    );
    return updated;
  }

  /**
   * Puts a user on a plan without Stripe (enterprise deals, comps). Refused
   * while a Stripe subscription is live: that must be cancelled in Stripe
   * first, or the two would disagree.
   */
  async assignPlan(
    actorId: string,
    userId: string,
    dto: AdminAssignPlanDto,
  ): Promise<SubscriptionWithPlan> {
    await this.subscriptions.ensureAccount(userId);
    const plan = await this.repository.findPlan(dto.planId);
    if (!plan)
      throw AppError.notFound(ErrorCode.PlanNotFound, 'Plan not found');
    if (plan.tier === PlanTier.FREE) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Use a paid or enterprise plan',
      );
    }
    if (dto.packageId) {
      const pkg = await this.repository.findPackage(dto.packageId);
      if (!pkg || pkg.planId !== plan.id) {
        throw AppError.notFound(
          ErrorCode.PackageNotFound,
          'Package not found for this plan',
        );
      }
    }

    const { monthsAfterPeriodEnd } = await this.settings.get('token_expiry');
    const subscriptionId = await this.repository.transaction(async (tx) => {
      await this.repository.lockAccount(userId, tx);
      const live = await this.repository.findLiveSubscription(userId, tx);
      if (live?.stripeSubscriptionId) {
        throw AppError.conflict(
          ErrorCode.SubscriptionNotManagedByStripe,
          'The user has a Stripe subscription; cancel it in Stripe before assigning a manual plan',
        );
      }
      const now = new Date();
      if (live) {
        await this.repository.updateSubscription(
          live.id,
          { status: SubscriptionStatus.CANCELLED, cancelledAt: now },
          tx,
        );
        await this.tokens.startScheduledExpiry(userId, tx);
      }
      const periodEnd = addMonths(now, dto.interval === 'YEARLY' ? 12 : 1);
      const created = await this.repository.createSubscription(
        {
          userId,
          planId: plan.id,
          packageId: dto.packageId ?? null,
          interval: dto.interval,
          status: SubscriptionStatus.ACTIVE,
          tokenAllocation: dto.tokenAllocation,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
        tx,
      );
      if (dto.tokenAllocation > 0) {
        await this.tokens.grant(
          {
            userId,
            amount: dto.tokenAllocation,
            source: TokenBatchSource.ADMIN_GRANT,
            idempotencyKey: `admin-plan:${created.id}`,
            reason: 'admin_plan_assignment',
            subscriptionId: created.id,
            scheduledExpiryAt: addMonths(periodEnd, monthsAfterPeriodEnd),
            metadata: { assignedBy: actorId, planId: plan.id },
          },
          tx,
        );
      }
      await this.repository.createEvent(
        {
          userId,
          subscriptionId: created.id,
          type: 'admin_assigned',
          fromPackageId: live?.packageId ?? null,
          toPackageId: dto.packageId ?? null,
          tokensDelta: dto.tokenAllocation,
          metadata: {
            assignedBy: actorId,
            planId: plan.id,
            interval: dto.interval,
          },
        },
        tx,
      );
      return created.id;
    });

    this.logger.log(`Admin ${actorId} assigned plan ${plan.id} to ${userId}`);
    const live = await this.repository.findLiveSubscription(userId);
    if (!live || live.id !== subscriptionId)
      throw new Error('Assigned subscription not found after commit');
    return live;
  }

  async stats(): Promise<{
    subscriptionsByPlan: Array<{ planId: string; count: number }>;
    tokensUsedLast30Days: number;
  }> {
    const [subscriptionsByPlan, tokensUsedLast30Days] = await Promise.all([
      this.repository.countLiveByPlan(),
      this.repository.usageSince(addDays(new Date(), -30)),
    ]);
    return { subscriptionsByPlan, tokensUsedLast30Days };
  }
}
