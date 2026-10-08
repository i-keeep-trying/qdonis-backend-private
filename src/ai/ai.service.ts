import { randomUUID } from 'node:crypto';

import { HttpException, Injectable, Logger } from '@nestjs/common';

import { SubscriptionsService } from '../billing/subscriptions.service';
import { TokensService } from '../billing/tokens.service';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { SettingsService } from '../settings/settings.service';
import { BedrockClient } from './bedrock.client';
import type { ConverseDto } from './dto/converse.dto';

export interface ConverseOutcome {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Tokens deducted from the balance (after the step multiplier). */
  charged: number;
  balance: number;
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

  /** Validates config, model and balance. Throws before any streaming starts. */
  async prepare(userId: string, dto: ConverseDto): Promise<string> {
    this.bedrock.assertConfigured();
    const modelId = this.bedrock.resolveModel(dto.modelId);
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
      messages: dto.messages,
      temperature: dto.temperature ?? 0.25,
      maxTokens: dto.maxTokens ?? 64_000,
      signal,
    });

    const totalTokens = result.inputTokens + result.outputTokens;
    const multiplier = await this.stepMultiplier(dto.step);
    const amount = Math.ceil(totalTokens * multiplier);
    const { charged, balance } = await this.charge(userId, amount, {
      modelId,
      step: dto.step ?? null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      multiplier,
    });

    return {
      content: result.content,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens,
      },
      charged,
      balance,
    };
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
