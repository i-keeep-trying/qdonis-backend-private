import { randomUUID } from 'node:crypto';

import { HttpException, Injectable, Logger } from '@nestjs/common';

import { SubscriptionsService } from '../billing/subscriptions.service';
import { TokensService } from '../billing/tokens.service';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { SettingsService } from '../settings/settings.service';
import { BedrockClient } from './bedrock/bedrock.client';
import type { ConverseDto } from './dto/converse.dto';

export interface ConverseOutcome {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Tokens deducted from the balance (after the step multiplier). */
  charged: number;
  balance: number;
}

export interface UsageCharge {
  modelId: string;
  /** Pipeline step, for the admin step multiplier; none = multiplier 1. */
  step?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChargeOutcome {
  charged: number;
  balance: number;
  multiplier: number;
}

/**
 * Server-side AI calls. The caller must have tokens before the call starts,
 * and usage is charged here from the provider's own token counts, so the
 * browser can neither skip nor under-report it.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly bedrock: BedrockClient,
    private readonly tokens: TokensService,
    private readonly subscriptions: SubscriptionsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Validates config, model and balance; returns the model id to use. Throws
   * before any streaming starts.
   */
  async prepare(userId: string, requestedModel?: string): Promise<string> {
    this.bedrock.assertConfigured();
    const modelId = this.bedrock.resolveModel(requestedModel);
    await this.subscriptions.ensureAccount(userId);
    const balance = await this.tokens.balance(userId);
    if (balance <= 0) {
      throw AppError.paymentRequired(
        ErrorCode.InsufficientTokens,
        'You are out of tokens',
        {
          balance: 0,
          required: 1,
          shortfall: 1,
        },
      );
    }
    return modelId;
  }

  async converse(
    userId: string,
    modelId: string,
    dto: ConverseDto,
    signal: AbortSignal,
  ): Promise<ConverseOutcome> {
    const result = await this.bedrock.converse({
      modelId,
      messages: dto.messages.map((m) => ({
        role: m.role,
        content: [{ text: m.content }],
      })),
      temperature: dto.temperature ?? 0.25,
      maxTokens: dto.maxTokens ?? 64_000,
      signal,
    });
    const { inputTokens, outputTokens } = result.usage;

    const { charged, balance } = await this.chargeUsage(userId, {
      modelId,
      step: dto.step,
      inputTokens,
      outputTokens,
    });

    return {
      content: result.text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      charged,
      balance,
    };
  }

  /**
   * Charges one completed AI call: `ceil((input + output) * multiplier)`,
   * under a fresh idempotency key. Call exactly once per provider call.
   */
  async chargeUsage(
    userId: string,
    usage: UsageCharge,
  ): Promise<ChargeOutcome> {
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const multiplier = await this.stepMultiplier(usage.step);
    const amount = Math.ceil(totalTokens * multiplier);
    const { charged, balance } = await this.charge(userId, amount, {
      modelId: usage.modelId,
      step: usage.step ?? null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      multiplier,
    });
    return { charged, balance, multiplier };
  }

  /**
   * Charges `amount`; if the balance ran short during the call, charges what
   * is left instead, so a completed call is never free.
   */
  private async charge(
    userId: string,
    amount: number,
    metadata: Record<string, string | number | null>,
  ): Promise<{ charged: number; balance: number }> {
    if (amount <= 0)
      return { charged: 0, balance: await this.tokens.balance(userId) };
    const key = `ai:${userId}:${randomUUID()}`;
    try {
      const result = await this.tokens.consume({
        userId,
        amount,
        idempotencyKey: key,
        reason: 'ai_usage',
        metadata,
      });
      return { charged: amount, balance: result.balance };
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() !== 402)
        throw error;
      const remaining = await this.tokens.balance(userId);
      if (remaining > 0) {
        await this.tokens.consume({
          userId,
          amount: remaining,
          idempotencyKey: `${key}:remainder`,
          reason: 'ai_usage',
          metadata: { ...metadata, requested: amount },
        });
      }
      this.logger.warn(
        `User ${userId} exceeded balance: charged ${remaining} of ${amount}`,
      );
      return { charged: remaining, balance: 0 };
    }
  }

  private async stepMultiplier(step?: string): Promise<number> {
    if (!step) return 1;
    const { multipliers } = await this.settings.get('step_multipliers');
    return multipliers[step.toLowerCase().replace(/[\s-]+/g, '_')] ?? 1;
  }
}
