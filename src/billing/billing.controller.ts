import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuthThrottle } from '../common/decorators/auth-throttle.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { SettingsService } from '../settings/settings.service';
import {
  addonView,
  eventView,
  ledgerView,
  overviewView,
  planView,
} from './billing.views';
import { CatalogService } from './catalog.service';
import {
  AddonCheckoutDto,
  PackageSelectionDto,
  ReportUsageDto,
} from './dto/billing.dto';
import { SubscriptionsService } from './subscriptions.service';
import { TokensService } from './tokens.service';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly tokens: TokensService,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
  ) {}

  @Public()
  @Get('plans')
  @ApiOperation({
    summary: 'Public price list: active plans and their packages',
  })
  async plans() {
    return (await this.catalog.listPlans()).map((plan) => planView(plan));
  }

  @Public()
  @Get('signup-bonus')
  @ApiOperation({
    summary: 'Trial offered to new accounts (for the welcome screen)',
  })
  async signupBonus() {
    const bonus = await this.settings.get('signup_bonus');
    return {
      enabled: bonus.enabled,
      bonusTokens: bonus.enabled ? bonus.bonusTokens : 0,
      trialDays: bonus.trialDays,
    };
  }

  @Get('pricing')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Token pricing settings the app uses to estimate and display costs',
  })
  async pricing() {
    const [
      modelConfig,
      tokenPricing,
      stepMultipliers,
      signupBonus,
      tokenExpiry,
    ] = await Promise.all([
      this.settings.get('model_config'),
      this.settings.get('token_pricing'),
      this.settings.get('step_multipliers'),
      this.settings.get('signup_bonus'),
      this.settings.get('token_expiry'),
    ]);
    return {
      modelConfig: { ...modelConfig },
      tokenPricing: { ...tokenPricing },
      stepMultipliers: { ...stepMultipliers.multipliers },
      signupBonus: { ...signupBonus },
      tokenExpiry: { ...tokenExpiry },
    };
  }

  @Get('addons')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Token top-ups and the custom top-up limits' })
  async addons() {
    const [addons, pricing] = await Promise.all([
      this.catalog.listAddons(),
      this.settings.get('addon_pricing'),
    ]);
    return {
      packages: addons.map((addon) => addonView(addon)),
      custom: {
        tokensPerUsd: pricing.tokensPerUsd,
        minCents: pricing.customMinCents,
        maxCents: pricing.customMaxCents,
      },
    };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My plan, token balance and token batches' })
  async me(@CurrentUser('id') userId: string) {
    return overviewView(await this.subscriptions.overview(userId));
  }

  @Get('me/ledger')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My token movements, newest first' })
  async ledger(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total } = await this.subscriptions.ledgerPage(
      userId,
      query.skip,
      query.take,
    );
    return new PaginatedResultDto(
      items.map(ledgerView),
      total,
      query.skip,
      query.take,
    );
  }

  @Get('me/events')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My subscription history, newest first' })
  async events(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total } = await this.subscriptions.eventPage(
      userId,
      query.skip,
      query.take,
    );
    return new PaginatedResultDto(
      items.map(eventView),
      total,
      query.skip,
      query.take,
    );
  }

  @AuthThrottle()
  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Start Stripe Checkout for a paid plan; redirect the browser to `url`',
  })
  @ApiConflictResponse({ description: 'ALREADY_SUBSCRIBED' })
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PackageSelectionDto,
  ) {
    return this.subscriptions.createCheckout(user, dto);
  }

  @AuthThrottle()
  @Post('addons/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start Stripe Checkout for a token top-up' })
  @ApiPaymentRequiredResponse({
    description: 'PAID_PLAN_REQUIRED | PAYMENT_FAILED',
  })
  addonCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddonCheckoutDto,
  ) {
    return this.subscriptions.createAddonCheckout(user, dto);
  }

  @AuthThrottle()
  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Stripe Billing Portal (invoices, payment methods)',
  })
  portal(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.createPortal(user);
  }

  @AuthThrottle()
  @Post('subscription/change')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change plan',
    description:
      'Upgrades apply now and are charged prorated; their extra tokens arrive once Stripe confirms payment. Downgrades take effect at the next renewal and must keep the billing interval.',
  })
  @ApiPaymentRequiredResponse({
    description: 'PAYMENT_FAILED | PAID_PLAN_REQUIRED',
  })
  @ApiConflictResponse({ description: 'SAME_PLAN | CANCELLATION_PENDING' })
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PackageSelectionDto,
  ) {
    return this.subscriptions.changePlan(user, dto);
  }

  @AuthThrottle()
  @Delete('subscription/scheduled-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdraw a scheduled downgrade' })
  @ApiNoContentResponse()
  cancelScheduledChange(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.subscriptions.cancelScheduledChange(user);
  }

  @AuthThrottle()
  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel at the end of the paid period' })
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.cancel(user);
  }

  @AuthThrottle()
  @Post('subscription/resume')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Undo a pending cancellation' })
  @ApiNoContentResponse()
  resume(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.subscriptions.resume(user);
  }

  @Post('usage')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record token usage (all or nothing, idempotent)',
    description:
      'Fails with 402 INSUFFICIENT_TOKENS (meta: balance, required, shortfall) without deducting anything.',
  })
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async usage(@CurrentUser('id') userId: string, @Body() dto: ReportUsageDto) {
    await this.subscriptions.ensureAccount(userId);
    return this.tokens.consume({
      userId,
      amount: dto.amount,
      // Namespaced so one user's keys can never collide with another's.
      idempotencyKey: `usage:${userId}:${dto.idempotencyKey}`,
      reason: dto.reason || 'usage',
      metadata: limitMetadata(dto.metadata),
    });
  }
}

/** Keeps client-supplied metadata small and JSON-safe. */
function limitMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return {};
  const json = JSON.stringify(metadata);
  if (json.length > 2_000) return { truncated: true };
  return JSON.parse(json) as Record<string, string | number | boolean | null>;
}
