import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { AppConfiguration } from '../config/configuration';
import type { TokenBatch } from '../generated/prisma/client';
import {
  type BillingInterval,
  SubscriptionStatus,
  TokenBatchSource,
} from '../generated/prisma/enums';
import { SettingsService } from '../settings/settings.service';
import {
  BillingRepository,
  isUniqueViolationOn,
  type SubscriptionWithPlan,
} from './billing.repository';
import { CatalogService, periodTokens, priceIdFor } from './catalog.service';
import type { AddonCheckoutDto, PackageSelectionDto } from './dto/billing.dto';
import { StripeClient } from './stripe/stripe.client';
import { addDays, TokensService } from './tokens.service';

export interface BillingActor {
  id: string;
  email: string;
}

export interface BillingOverview {
  subscription: SubscriptionWithPlan | null;
  balance: number;
  batches: TokenBatch[];
  trialGrantedAt: Date | null;
  hasStripeCustomer: boolean;
}

/**
 * The user-facing subscription lifecycle. Every Stripe-side change is
 * requested here, but local state for paid plans changes only when the
 * verified webhook confirms it (see StripeWebhookService), so the database
 * never claims something Stripe has not done.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly tokens: TokensService,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeClient,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * Creates the billing account on first use and, exactly once per user,
   * starts the free plan with the signup trial. Safe under concurrency: the
   * insert is ON CONFLICT DO NOTHING and only its winner grants anything.
   */
  async ensureAccount(userId: string): Promise<void> {
    if (await this.repository.findAccount(userId)) return;

    const bonus = await this.settings.get('signup_bonus');
    await this.repository.transaction(async (tx) => {
      const created = await this.repository.createAccountIfMissing(userId, tx);
      if (!created) return;

      const now = new Date();
      const trialTokens = bonus.enabled ? bonus.bonusTokens : 0;
      const trialEnd = addDays(now, bonus.trialDays);
      const subscription = await this.repository.createSubscription(
        {
          userId,
          planId: this.catalog.freePlanId(),
          status: SubscriptionStatus.ACTIVE,
          tokenAllocation: trialTokens,
          currentPeriodStart: now,
          currentPeriodEnd: trialTokens > 0 ? trialEnd : null,
        },
        tx,
      );

      if (trialTokens > 0) {
        await this.tokens.grant(
          {
            userId,
            amount: trialTokens,
            source: TokenBatchSource.TRIAL,
            idempotencyKey: `trial:${userId}`,
            reason: 'signup_trial',
            subscriptionId: subscription.id,
            expiresAt: trialEnd,
          },
          tx,
        );
        await this.repository.updateAccount(
          userId,
          { trialGrantedAt: now },
          tx,
        );
      }
      await this.repository.createEvent(
        {
          userId,
          subscriptionId: subscription.id,
          type: 'created',
          tokensDelta: trialTokens,
          metadata: { source: 'signup', trialDays: bonus.trialDays },
        },
        tx,
      );
    });
  }

  async overview(userId: string): Promise<BillingOverview> {
    await this.ensureAccount(userId);
    const [subscription, balance, batches, account] = await Promise.all([
      this.repository.findLiveSubscription(userId),
      this.tokens.balance(userId),
      this.tokens.usableBatches(userId),
      this.repository.findAccount(userId),
    ]);
    return {
      subscription,
      balance,
      batches,
      trialGrantedAt: account?.trialGrantedAt ?? null,
      hasStripeCustomer: Boolean(account?.stripeCustomerId),
    };
  }

  ledgerPage(userId: string, skip: number, take: number) {
    return this.repository.ledgerPage(userId, skip, take);
  }

  eventPage(userId: string, skip: number, take: number) {
    return this.repository.eventPage(userId, skip, take);
  }

  // --- checkout ------------------------------------------------------------

  /** Stripe Checkout for a new paid subscription. Returns the hosted URL. */
  async createCheckout(
    actor: BillingActor,
    dto: PackageSelectionDto,
  ): Promise<{ url: string }> {
    await this.ensureAccount(actor.id);
    const { pkg, priceId } = await this.catalog.purchasable(
      dto.packageId,
      dto.interval,
    );

    const live = await this.repository.findLiveSubscription(actor.id);
    if (live?.stripeSubscriptionId) {
      throw AppError.conflict(
        ErrorCode.AlreadySubscribed,
        'You already have a paid subscription; change plans instead',
      );
    }

    const customer = await this.customerFor(actor);
    const metadata = {
      kind: 'subscription',
      userId: actor.id,
      packageId: pkg.id,
      interval: dto.interval,
    };
    const session = await this.stripe.call('checkout.create', (stripe) =>
      stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: actor.id,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata,
        subscription_data: { metadata },
        allow_promotion_codes: true,
        success_url: this.frontendUrl(
          '/subscription?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        ),
        cancel_url: this.frontendUrl('/subscription?checkout=cancelled'),
      }),
    );
    return { url: requireUrl(session.url) };
  }

  /** One-time token top-up. Only for users on an active paid plan. */
  async createAddonCheckout(
    actor: BillingActor,
    dto: AddonCheckoutDto,
  ): Promise<{ url: string }> {
    const live = await this.requirePaidSubscription(actor.id);
    if (live.status !== SubscriptionStatus.ACTIVE) {
      throw AppError.paymentRequired(
        ErrorCode.PaymentFailed,
        'Update your payment method before buying tokens',
      );
    }

    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;
    let tokenAmount: number;
    let addonId: string;

    if (dto.addonId !== undefined && dto.amountCents !== undefined) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Send either addonId or amountCents, not both',
      );
    }
    if (dto.addonId !== undefined) {
      const addon = await this.catalog.addon(dto.addonId);
      lineItem = { price: addon.stripePriceId as string, quantity: 1 };
      tokenAmount = addon.tokenAmount;
      addonId = addon.id;
    } else {
      const pricing = await this.settings.get('addon_pricing');
      const cents = dto.amountCents ?? 0;
      if (cents < pricing.customMinCents || cents > pricing.customMaxCents) {
        throw AppError.badRequest(
          ErrorCode.InvalidAmount,
          `Custom amount must be between $${(pricing.customMinCents / 100).toFixed(2)} and $${(pricing.customMaxCents / 100).toFixed(2)}`,
        );
      }
      tokenAmount = Math.floor((cents / 100) * pricing.tokensPerUsd);
      addonId = 'custom';
      lineItem = {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: `Token top-up (${tokenAmount.toLocaleString('en-US')} tokens)`,
          },
        },
      };
    }

    const customer = await this.customerFor(actor);
    const session = await this.stripe.call('addon.create', (stripe) =>
      stripe.checkout.sessions.create({
        mode: 'payment',
        customer,
        client_reference_id: actor.id,
        line_items: [lineItem],
        // Token amount is fixed server-side now and re-read by the webhook,
        // so the client can never choose how many tokens a payment buys.
        metadata: {
          kind: 'addon',
          userId: actor.id,
          addonId,
          tokenAmount: String(tokenAmount),
        },
        payment_intent_data: {
          metadata: { kind: 'addon', userId: actor.id, addonId },
        },
        success_url: this.frontendUrl(
          '/subscription?addon=success&session_id={CHECKOUT_SESSION_ID}',
        ),
        cancel_url: this.frontendUrl('/subscription?addon=cancelled'),
      }),
    );
    return { url: requireUrl(session.url) };
  }

  /** Stripe Billing Portal for invoices and payment methods. */
  async createPortal(actor: BillingActor): Promise<{ url: string }> {
    const account = await this.repository.findAccount(actor.id);
    if (!account?.stripeCustomerId) {
      throw AppError.conflict(
        ErrorCode.NoActiveSubscription,
        'No billing details on file yet',
      );
    }
    const customer = account.stripeCustomerId;
    const session = await this.stripe.call('portal.create', (stripe) =>
      stripe.billingPortal.sessions.create({
        customer,
        return_url: this.frontendUrl('/subscription'),
      }),
    );
    return { url: session.url };
  }

  // --- plan changes ------------------------------------------------------------

  /**
   * Upgrade (more tokens per period): applied now, prorated and charged
   * immediately; the token difference is granted when Stripe confirms the
   * invoice. Downgrade: scheduled for the next renewal, no refund.
   */
  async changePlan(
    actor: BillingActor,
    dto: PackageSelectionDto,
  ): Promise<{ kind: 'upgrade' | 'downgrade'; effectiveAt: Date | null }> {
    const live = await this.requireChangeableSubscription(actor.id);
    const { pkg, priceId } = await this.catalog.purchasable(
      dto.packageId,
      dto.interval,
    );
    const currentInterval = live.interval as BillingInterval;

    if (pkg.id === live.packageId && dto.interval === currentInterval) {
      throw AppError.conflict(
        ErrorCode.SamePlan,
        'You are already on this plan',
      );
    }

    const stripeSub = await this.retrieveStripeSubscription(
      live.stripeSubscriptionId as string,
    );
    const item = stripeSub.items.data[0];
    if (!item)
      throw new Error(`Stripe subscription ${stripeSub.id} has no items`);

    const isUpgrade = periodTokens(pkg, dto.interval) > live.tokenAllocation;

    if (isUpgrade) {
      await this.stripe.call('subscription.upgrade', (stripe) =>
        stripe.subscriptions.update(stripeSub.id, {
          items: [{ id: item.id, price: priceId }],
          proration_behavior: 'always_invoice',
          // Fail the change outright if the prorated charge is declined,
          // instead of leaving the subscription on a plan nobody paid for.
          payment_behavior: 'error_if_incomplete',
          metadata: {
            userId: actor.id,
            packageId: pkg.id,
            interval: dto.interval,
          },
        }),
      );
      await this.repository.transaction(async (tx) => {
        await this.repository.updateSubscription(
          live.id,
          { scheduledPackageId: null, scheduledInterval: null },
          tx,
        );
        await this.repository.createEvent(
          {
            userId: actor.id,
            subscriptionId: live.id,
            type: 'upgrade_requested',
            fromPackageId: live.packageId,
            toPackageId: pkg.id,
            metadata: { interval: dto.interval },
          },
          tx,
        );
      });
      return { kind: 'upgrade', effectiveAt: null };
    }

    // Changing the interval resets Stripe's billing cycle immediately, which
    // contradicts "takes effect at renewal"; only same-interval downgrades.
    if (dto.interval !== currentInterval) {
      throw AppError.badRequest(
        ErrorCode.PackageNotPurchasable,
        'Switching to a smaller plan must keep the same billing interval',
      );
    }

    // New price applies from the next invoice; nothing is charged or refunded now.
    await this.stripe.call('subscription.downgrade', (stripe) =>
      stripe.subscriptions.update(stripeSub.id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'none',
        metadata: {
          userId: actor.id,
          packageId: pkg.id,
          interval: dto.interval,
        },
      }),
    );
    await this.repository.transaction(async (tx) => {
      await this.repository.updateSubscription(
        live.id,
        { scheduledPackageId: pkg.id, scheduledInterval: dto.interval },
        tx,
      );
      await this.repository.createEvent(
        {
          userId: actor.id,
          subscriptionId: live.id,
          type: 'downgrade_scheduled',
          fromPackageId: live.packageId,
          toPackageId: pkg.id,
          metadata: {
            effectiveAt: live.currentPeriodEnd?.toISOString() ?? null,
          },
        },
        tx,
      );
    });
    return { kind: 'downgrade', effectiveAt: live.currentPeriodEnd };
  }

  /** Withdraws a scheduled downgrade by restoring the current price in Stripe. */
  async cancelScheduledChange(actor: BillingActor): Promise<void> {
    const live = await this.requireChangeableSubscription(actor.id);
    if (!live.scheduledPackageId || !live.package) {
      throw AppError.conflict(
        ErrorCode.NoScheduledChange,
        'There is no scheduled plan change',
      );
    }
    const priceId = priceIdFor(live.package, live.interval as BillingInterval);
    if (!priceId)
      throw new Error(
        `Package ${live.package.id} has no Stripe price for its interval`,
      );

    const stripeSub = await this.retrieveStripeSubscription(
      live.stripeSubscriptionId as string,
    );
    const item = stripeSub.items.data[0];
    if (!item)
      throw new Error(`Stripe subscription ${stripeSub.id} has no items`);

    await this.stripe.call('subscription.revertDowngrade', (stripe) =>
      stripe.subscriptions.update(stripeSub.id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'none',
      }),
    );
    await this.repository.transaction(async (tx) => {
      await this.repository.updateSubscription(
        live.id,
        { scheduledPackageId: null, scheduledInterval: null },
        tx,
      );
      await this.repository.createEvent(
        {
          userId: actor.id,
          subscriptionId: live.id,
          type: 'downgrade_cancelled',
          toPackageId: live.packageId,
        },
        tx,
      );
    });
  }

  /** Cancels at the end of the paid period; tokens stay usable until then. */
  async cancel(actor: BillingActor): Promise<{ effectiveAt: Date | null }> {
    const live = await this.requirePaidSubscription(actor.id);
    if (live.cancelAtPeriodEnd) {
      throw AppError.conflict(
        ErrorCode.CancellationPending,
        'The subscription is already set to cancel',
      );
    }
    await this.stripe.call('subscription.cancel', (stripe) =>
      stripe.subscriptions.update(live.stripeSubscriptionId as string, {
        cancel_at_period_end: true,
      }),
    );
    await this.repository.transaction(async (tx) => {
      await this.repository.updateSubscription(
        live.id,
        { cancelAtPeriodEnd: true },
        tx,
      );
      await this.repository.createEvent(
        {
          userId: actor.id,
          subscriptionId: live.id,
          type: 'cancellation_requested',
          metadata: {
            effectiveAt: live.currentPeriodEnd?.toISOString() ?? null,
          },
        },
        tx,
      );
    });
    return { effectiveAt: live.currentPeriodEnd };
  }

  async resume(actor: BillingActor): Promise<void> {
    const live = await this.requirePaidSubscription(actor.id);
    if (!live.cancelAtPeriodEnd) {
      throw AppError.conflict(
        ErrorCode.NotCancelling,
        'The subscription is not set to cancel',
      );
    }
    await this.stripe.call('subscription.resume', (stripe) =>
      stripe.subscriptions.update(live.stripeSubscriptionId as string, {
        cancel_at_period_end: false,
      }),
    );
    await this.repository.transaction(async (tx) => {
      await this.repository.updateSubscription(
        live.id,
        { cancelAtPeriodEnd: false },
        tx,
      );
      await this.repository.createEvent(
        {
          userId: actor.id,
          subscriptionId: live.id,
          type: 'cancellation_withdrawn',
        },
        tx,
      );
    });
  }

  // --- helpers -------------------------------------------------------------------

  /**
   * Returns the user's Stripe customer, creating it once. The Stripe
   * idempotency key collapses concurrent first-time creations into one
   * customer; the conditional DB write keeps whichever was stored first.
   */
  private async customerFor(actor: BillingActor): Promise<string> {
    const account = await this.repository.findAccount(actor.id);
    if (account?.stripeCustomerId) return account.stripeCustomerId;

    const customer = await this.stripe.call('customer.create', (stripe) =>
      stripe.customers.create(
        { email: actor.email, metadata: { userId: actor.id } },
        { idempotencyKey: `customer-create:${actor.id}` },
      ),
    );
    try {
      await this.repository.setCustomerIfMissing(actor.id, customer.id);
    } catch (error) {
      if (!isUniqueViolationOn(error, 'stripe_customer_id')) throw error;
    }
    const stored = await this.repository.findAccount(actor.id);
    return stored?.stripeCustomerId ?? customer.id;
  }

  private async requirePaidSubscription(
    userId: string,
  ): Promise<SubscriptionWithPlan> {
    await this.ensureAccount(userId);
    const live = await this.repository.findLiveSubscription(userId);
    if (!live?.stripeSubscriptionId) {
      throw AppError.paymentRequired(
        ErrorCode.PaidPlanRequired,
        'This requires an active paid plan',
      );
    }
    return live;
  }

  private async requireChangeableSubscription(
    userId: string,
  ): Promise<SubscriptionWithPlan> {
    const live = await this.requirePaidSubscription(userId);
    if (live.status === SubscriptionStatus.PAST_DUE) {
      throw AppError.paymentRequired(
        ErrorCode.PaymentFailed,
        'Update your payment method before changing plans',
      );
    }
    if (live.cancelAtPeriodEnd) {
      throw AppError.conflict(
        ErrorCode.CancellationPending,
        'Resume the subscription before changing plans',
      );
    }
    if (!live.interval || !live.packageId) {
      throw new Error(
        `Paid subscription ${live.id} is missing its package or interval`,
      );
    }
    return live;
  }

  private retrieveStripeSubscription(id: string): Promise<Stripe.Subscription> {
    return this.stripe.call('subscription.retrieve', async (stripe) => {
      const subscription = await stripe.subscriptions.retrieve(id);
      if (!['active', 'trialing'].includes(subscription.status)) {
        throw AppError.conflict(
          ErrorCode.NoActiveSubscription,
          'The subscription is not active in Stripe',
        );
      }
      return subscription;
    });
  }

  private frontendUrl(pathAndQuery: string): string {
    return `${this.config.get('app', { infer: true }).frontendUrl}${pathAndQuery}`;
  }
}

function requireUrl(url: string | null): string {
  if (!url) throw new Error('Stripe returned a checkout session without a URL');
  return url;
}
