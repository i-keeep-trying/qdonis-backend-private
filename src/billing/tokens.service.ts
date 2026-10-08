import { Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { Prisma, TokenBatch } from '../generated/prisma/client';
import type { TokenBatchSource } from '../generated/prisma/enums';
import { BillingRepository, type DbClient } from './billing.repository';

/** Largest amount accepted in one grant or usage report. */
export const MAX_TOKEN_AMOUNT = 100_000_000;

export interface GrantInput {
  userId: string;
  amount: number;
  source: TokenBatchSource;
  /** Globally unique; a repeated key is a no-op (safe retries). */
  idempotencyKey: string;
  reason: string;
  subscriptionId?: string | null;
  expiresAt?: Date | null;
  scheduledExpiryAt?: Date | null;
  note?: string | null;
  metadata?: Prisma.InputJsonObject;
}

export interface ConsumeResult {
  consumed: number;
  balance: number;
  /** True when this key was already applied earlier (retry). */
  replayed: boolean;
}

/**
 * Token accounting. All mutations run inside a transaction that holds the
 * user's billing-account row lock (see `BillingRepository.lockAccount`), so
 * concurrent usage can never overdraw and grants can never double-apply.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(private readonly repository: BillingRepository) {}

  balance(userId: string, db?: DbClient): Promise<number> {
    return this.repository.balance(userId, new Date(), db);
  }

  usableBatches(userId: string): Promise<TokenBatch[]> {
    return this.repository.usableBatches(userId, new Date());
  }

  /**
   * Grants tokens as a new batch, inside the caller's transaction (which must
   * hold the account lock). Returns false if the key was already applied.
   */
  async grant(input: GrantInput, tx: DbClient): Promise<boolean> {
    assertAmount(input.amount);
    if (await this.repository.findLedgerEntry(input.idempotencyKey, tx))
      return false;

    await this.repository.createBatch(
      {
        userId: input.userId,
        subscriptionId: input.subscriptionId ?? null,
        source: input.source,
        tokensGranted: input.amount,
        expiresAt: input.expiresAt ?? null,
        scheduledExpiryAt: input.scheduledExpiryAt ?? null,
        note: input.note ?? null,
      },
      tx,
    );
    await this.repository.createLedgerEntry(
      {
        userId: input.userId,
        amount: input.amount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        metadata: { source: input.source, ...(input.metadata ?? {}) },
      },
      tx,
    );
    return true;
  }

  /**
   * Deducts `amount` across usable batches, soonest-expiring first. All or
   * nothing: if the balance is short, nothing is deducted and 402
   * INSUFFICIENT_TOKENS carries the balance. Retrying with the same key
   * returns the original result instead of charging twice.
   */
  async consume(params: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    reason: string;
    metadata?: Prisma.InputJsonObject;
  }): Promise<ConsumeResult> {
    assertAmount(params.amount);

    return this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockAccount(params.userId, tx))) {
        throw AppError.paymentRequired(
          ErrorCode.InsufficientTokens,
          'Not enough tokens',
          {
            balance: 0,
            required: params.amount,
          },
        );
      }

      const previous = await this.repository.findLedgerEntry(
        params.idempotencyKey,
        tx,
      );
      if (previous) {
        if (
          previous.userId !== params.userId ||
          previous.amount !== -params.amount
        ) {
          throw AppError.conflict(
            ErrorCode.IdempotencyConflict,
            'This idempotency key was already used for a different request',
          );
        }
        return {
          consumed: params.amount,
          balance: await this.repository.balance(params.userId, new Date(), tx),
          replayed: true,
        };
      }

      const now = new Date();
      const batches = await this.repository.usableBatches(
        params.userId,
        now,
        tx,
      );
      const available = batches.reduce(
        (sum, b) => sum + (b.tokensGranted - b.tokensUsed),
        0,
      );
      if (available < params.amount) {
        throw AppError.paymentRequired(
          ErrorCode.InsufficientTokens,
          'Not enough tokens',
          {
            balance: available,
            required: params.amount,
            shortfall: params.amount - available,
          },
        );
      }

      let remaining = params.amount;
      for (const batch of batches) {
        if (remaining === 0) break;
        const take = Math.min(
          remaining,
          batch.tokensGranted - batch.tokensUsed,
        );
        if (!(await this.repository.consumeFromBatch(batch.id, take, tx))) {
          // Impossible while the account lock is held; abort rather than guess.
          throw new Error(`Token batch ${batch.id} changed during consumption`);
        }
        remaining -= take;
      }

      await this.repository.createLedgerEntry(
        {
          userId: params.userId,
          amount: -params.amount,
          reason: params.reason,
          idempotencyKey: params.idempotencyKey,
          metadata: params.metadata ?? {},
        },
        tx,
      );

      return {
        consumed: params.amount,
        balance: available - params.amount,
        replayed: false,
      };
    });
  }

  /** Current-period tokens start expiring (renewal, downgrade, cancellation). */
  async startScheduledExpiry(userId: string, tx: DbClient): Promise<void> {
    const count = await this.repository.startScheduledExpiry(userId, tx);
    if (count > 0)
      this.logger.log(
        `Started expiry on ${count} batch(es) for user ${userId}`,
      );
  }
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TOKEN_AMOUNT) {
    throw AppError.badRequest(
      ErrorCode.InvalidAmount,
      `Token amount must be an integer between 1 and ${MAX_TOKEN_AMOUNT}`,
    );
  }
}

/** `date` plus whole calendar months (end-of-month safe). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
