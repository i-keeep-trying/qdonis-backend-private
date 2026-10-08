import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';

import {
  SubscriptionStatus,
  TokenBatchSource,
} from '../generated/prisma/enums';
import { SettingsService } from '../settings/settings.service';
import {
  BillingRepository,
  type DbClient,
  type SubscriptionWithPlan,
} from './billing.repository';
import { CatalogService, periodTokens } from './catalog.service';
import {
  StripeClient,
  stripeId,
  subscriptionPeriod,
} from './stripe/stripe.client';
import { addMonths, TokensService } from './tokens.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for states a retry can fix later (e.g. events arriving early). Stripe retries on 5xx. */
export class RetryableWebhookError extends Error {}

const HANDLED = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Applies Stripe webhook events to local billing state.
 *
 * Exactly-once: the event id is inserted into `stripe_events` inside the same
 * transaction as its effects. A redelivery (or a concurrent duplicate, which
 * blocks on the primary key) finds the row and does nothing; a failure rolls
 * back both, so Stripe's retry reapplies cleanly.
 *
 * Stripe objects needed for a decision are fetched fresh before the
 * transaction, so out-of-order deliveries act on current Stripe state rather
 * than on a stale payload.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly tokens: TokensService,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeClient,
  ) {}

  async handle(event: Stripe.Event): Promise<void> {
    if (!HANDLED.has(event.type)) return;

    const work = await this.prepare(event);
    if (!work) return;

    const supersededStripeIds: string[] = [];
    const applied = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.claimStripeEvent(event.id, event.type, tx)))
        return false;
      await work(tx, supersededStripeIds);
      return true;
    });

    if (!applied) {
      this.logger.debug(`Stripe event ${event.id} already processed`);
      return;
    }
    this.logger.log(`Applied Stripe event ${event.type} ${event.id}`);

    // A user who completed two checkouts ends up with two Stripe
    // subscriptions; keep the newest, end the other one (prorated credit).
    for (const id of supersededStripeIds) {
      await this.stripe
        .call('subscription.cancelSuperseded', (stripe) =>
          stripe.subscriptions.cancel(id, { prorate: true }),
        )
        .then(() =>
          this.logger.warn(`Cancelled superseded Stripe subscription ${id}`),
        )
        .catch((error: unknown) =>
          this.logger.error(
            `Could not cancel superseded subscription ${id}: ${describe(error)}`,
          ),
        );
    }
  }

  /** Fetches what the event needs from Stripe and returns the DB work, or null to ignore. */
  private async prepare(
    event: Stripe.Event,
  ): Promise<((tx: DbClient, superseded: string[]) => Promise<void>) | null> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const kind = session.metadata?.kind;
        if (kind === 'subscription' && session.mode === 'subscription') {
          const subscriptionId = stripeId(session.subscription);
          if (!subscriptionId) return null;
          const subscription = await this.retrieve(subscriptionId);
          return (tx, superseded) =>
            this.onSubscriptionCheckout(session, subscription, tx, superseded);
        }
        if (kind === 'addon' && session.mode === 'payment') {
          return (tx) => this.onAddonCheckout(session, tx);
        }
        this.logger.warn(
          `Ignoring checkout session ${session.id} without recognised metadata`,
        );
        return null;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (!subscriptionId) return null;
        // The first invoice is handled by checkout.session.completed.
        if (invoice.billing_reason === 'subscription_create') return null;
        const subscription = await this.retrieve(subscriptionId);
        return (tx) => this.onInvoicePaid(invoice, subscription, tx);
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (!subscriptionId) return null;
        return (tx) => this.onPaymentFailed(invoice, subscriptionId, tx);
      }

      case 'customer.subscription.updated': {
        const subscription = await this.retrieve(event.data.object.id);
        return (tx) => this.onSubscriptionSync(subscription, tx);
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        return (tx) =>
          this.onSubscriptionEnded(subscription.id, 'stripe_deleted', tx);
      }

      default:
        return null;
    }
  }

  // --- handlers --------------------------------------------------------------

  private async onSubscriptionCheckout(
    session: Stripe.Checkout.Session,
    stripeSub: Stripe.Subscription,
    tx: DbClient,
    superseded: string[],
  ): Promise<void> {
    const userId = session.metadata?.userId ?? session.client_reference_id;
    if (!userId) {
      this.logger.error(`Checkout ${session.id} has no userId; ignoring`);
      return;
    }
    if (await this.repository.findByStripeId(stripeSub.id, tx)) return;
    if (!(await this.lockPayingUser(userId, tx))) {
      this.logger.error(
        `Checkout ${session.id} for unknown or deleted user ${userId}; ignoring`,
      );
      return;
    }

    const period = subscriptionPeriod(stripeSub);
    const resolved = period?.priceId
      ? await this.catalog.packageForPrice(period.priceId, tx)
      : null;
    if (!period || !resolved) {
      // Fixable by mapping the price in the admin panel; let Stripe retry.
      throw new RetryableWebhookError(
        `No package for price ${period?.priceId ?? 'none'} (checkout ${session.id})`,
      );
    }
    const { pkg, interval } = resolved;
    const allocation = periodTokens(pkg, interval);
    const expiry = await this.scheduledExpiry(period.end);
    const now = new Date();

    const previous = await this.repository.findLiveSubscription(userId, tx);
    if (previous) {
      await this.repository.updateSubscription(
        previous.id,
        {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: now,
          scheduledPackageId: null,
        },
        tx,
      );
      if (
        previous.stripeSubscriptionId &&
        previous.stripeSubscriptionId !== stripeSub.id
      ) {
        superseded.push(previous.stripeSubscriptionId);
      }
    }

    const customerId = stripeId(stripeSub.customer);
    if (customerId)
      await this.repository.setCustomerIfMissing(userId, customerId, tx);

    const subscription = await this.repository.createSubscription(
      {
        userId,
        planId: pkg.planId,
        packageId: pkg.id,
        interval,
        status: mapStatus(stripeSub.status) ?? SubscriptionStatus.ACTIVE,
        tokenAllocation: allocation,
        stripeSubscriptionId: stripeSub.id,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
      tx,
    );

    // Unused trial tokens are kept and now follow the paid period's expiry.
    const carried = await this.repository.carryTrialIntoPeriod(
      userId,
      expiry,
      now,
      tx,
    );
    await this.tokens.grant(
      {
        userId,
        amount: allocation,
        source: TokenBatchSource.PLAN_PURCHASE,
        idempotencyKey: `checkout:${session.id}`,
        reason: 'plan_purchase',
        subscriptionId: subscription.id,
        scheduledExpiryAt: expiry,
        metadata: {
          packageId: pkg.id,
          interval,
          stripeSubscriptionId: stripeSub.id,
        },
      },
      tx,
    );
    await this.repository.createEvent(
      {
        userId,
        subscriptionId: subscription.id,
        type: 'created',
        fromPackageId: previous?.packageId ?? null,
        toPackageId: pkg.id,
        tokensDelta: allocation,
        metadata: {
          source: 'stripe_checkout',
          checkoutSessionId: session.id,
          interval,
          amountPaidCents: session.amount_total ?? 0,
          trialBatchesCarried: carried,
        },
      },
      tx,
    );
  }

  private async onAddonCheckout(
    session: Stripe.Checkout.Session,
    tx: DbClient,
  ): Promise<void> {
    const userId = session.metadata?.userId ?? session.client_reference_id;
    const tokenAmount = Number.parseInt(
      session.metadata?.tokenAmount ?? '',
      10,
    );
    if (!userId || !Number.isInteger(tokenAmount) || tokenAmount <= 0) {
      this.logger.error(
        `Add-on checkout ${session.id} has invalid metadata; ignoring`,
      );
      return;
    }
    if (session.payment_status !== 'paid') {
      this.logger.warn(
        `Add-on checkout ${session.id} completed without payment (${session.payment_status})`,
      );
      return;
    }
    if (!(await this.lockPayingUser(userId, tx))) {
      this.logger.error(
        `Add-on checkout ${session.id} for unknown user ${userId}; payment needs a manual refund`,
      );
      return;
    }

    // Top-ups follow the current period's lifecycle; without a period they
    // get the standard expiry window from now.
    const live = await this.repository.findLiveSubscription(userId, tx);
    const anchor =
      live?.currentPeriodEnd && live.currentPeriodEnd > new Date()
        ? live.currentPeriodEnd
        : new Date();
    const expiry = await this.scheduledExpiry(anchor);
    const paid = Boolean(live?.stripeSubscriptionId);

    const granted = await this.tokens.grant(
      {
        userId,
        amount: tokenAmount,
        source: TokenBatchSource.ADDON,
        idempotencyKey: `addon:${session.id}`,
        reason: 'addon_purchase',
        subscriptionId: live?.id ?? null,
        scheduledExpiryAt: paid ? expiry : null,
        expiresAt: paid ? null : expiry,
        metadata: {
          checkoutSessionId: session.id,
          addonId: session.metadata?.addonId ?? null,
        },
      },
      tx,
    );
    if (!granted) return; // same session delivered under another event id
    await this.repository.createEvent(
      {
        userId,
        subscriptionId: live?.id ?? null,
        type: 'addon_purchased',
        tokensDelta: tokenAmount,
        metadata: {
          checkoutSessionId: session.id,
          addonId: session.metadata?.addonId ?? null,
          amountPaidCents: session.amount_total ?? 0,
        },
      },
      tx,
    );
  }

  /** Renewals (new period's tokens) and upgrades (token difference). */
  private async onInvoicePaid(
    invoice: Stripe.Invoice,
    stripeSub: Stripe.Subscription,
    tx: DbClient,
  ): Promise<void> {
    const local = await this.repository.findByStripeId(stripeSub.id, tx);
    if (!local) {
      throw new RetryableWebhookError(
        `Invoice ${invoice.id} for unknown subscription ${stripeSub.id}`,
      );
    }
    await this.repository.lockAccount(local.userId, tx);

    const period = subscriptionPeriod(stripeSub);
    const priceId = invoicePriceId(invoice) ?? period?.priceId ?? null;
    const resolved = priceId
      ? await this.catalog.packageForPrice(priceId, tx)
      : null;
    if (!period || !resolved) {
      throw new RetryableWebhookError(
        `No package for price ${priceId ?? 'none'} (invoice ${invoice.id})`,
      );
    }
    const { pkg, interval } = resolved;
    const allocation = periodTokens(pkg, interval);
    const expiry = await this.scheduledExpiry(period.end);

    if (invoice.billing_reason === 'subscription_cycle') {
      await this.applyRenewal(
        local,
        invoice,
        { pkg, interval, allocation, expiry, period },
        tx,
      );
      return;
    }

    if (invoice.billing_reason === 'subscription_update') {
      if (await this.repository.findLedgerEntry(`invoice:${invoice.id}`, tx))
        return;
      const difference = allocation - local.tokenAllocation;
      if (difference > 0) {
        await this.tokens.grant(
          {
            userId: local.userId,
            amount: difference,
            source: TokenBatchSource.UPGRADE,
            idempotencyKey: `invoice:${invoice.id}`,
            reason: 'plan_upgrade',
            subscriptionId: local.id,
            scheduledExpiryAt: expiry,
            metadata: {
              fromPackageId: local.packageId,
              toPackageId: pkg.id,
              invoiceId: invoice.id,
            },
          },
          tx,
        );
      }
      await this.repository.updateSubscription(
        local.id,
        {
          planId: pkg.planId,
          packageId: pkg.id,
          interval,
          tokenAllocation: Math.max(allocation, local.tokenAllocation),
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          scheduledPackageId: null,
          scheduledInterval: null,
        },
        tx,
      );
      await this.repository.createEvent(
        {
          userId: local.userId,
          subscriptionId: local.id,
          type: 'upgraded',
          fromPackageId: local.packageId,
          toPackageId: pkg.id,
          tokensDelta: Math.max(difference, 0),
          metadata: {
            invoiceId: invoice.id,
            amountPaidCents: invoice.amount_paid,
          },
        },
        tx,
      );
      return;
    }

    // Other reasons (manual invoices etc.) only confirm the account is in good standing.
    if (local.status === SubscriptionStatus.PAST_DUE) {
      await this.repository.updateSubscription(
        local.id,
        { status: SubscriptionStatus.ACTIVE },
        tx,
      );
    }
  }

  private async applyRenewal(
    local: SubscriptionWithPlan,
    invoice: Stripe.Invoice,
    next: {
      pkg: { id: string; planId: string };
      interval: SubscriptionWithPlan['interval'];
      allocation: number;
      expiry: Date;
      period: { start: Date; end: Date };
    },
    tx: DbClient,
  ): Promise<void> {
    // The whole renewal is keyed by invoice, not just the grant: rolling
    // over twice would start the new period's tokens expiring.
    if (await this.repository.findLedgerEntry(`invoice:${invoice.id}`, tx))
      return;
    // Last period's unused tokens roll over and start their expiry clock.
    await this.tokens.startScheduledExpiry(local.userId, tx);
    await this.tokens.grant(
      {
        userId: local.userId,
        amount: next.allocation,
        source: TokenBatchSource.RENEWAL,
        idempotencyKey: `invoice:${invoice.id}`,
        reason: 'renewal',
        subscriptionId: local.id,
        scheduledExpiryAt: next.expiry,
        metadata: { packageId: next.pkg.id, invoiceId: invoice.id },
      },
      tx,
    );
    const changed = next.pkg.id !== local.packageId;
    await this.repository.updateSubscription(
      local.id,
      {
        planId: next.pkg.planId,
        packageId: next.pkg.id,
        interval: next.interval,
        tokenAllocation: next.allocation,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: next.period.start,
        currentPeriodEnd: next.period.end,
        scheduledPackageId: null,
        scheduledInterval: null,
      },
      tx,
    );
    await this.repository.createEvent(
      {
        userId: local.userId,
        subscriptionId: local.id,
        type: changed ? 'downgraded' : 'renewed',
        fromPackageId: local.packageId,
        toPackageId: next.pkg.id,
        tokensDelta: next.allocation,
        metadata: {
          invoiceId: invoice.id,
          amountPaidCents: invoice.amount_paid,
        },
      },
      tx,
    );
  }

  private async onPaymentFailed(
    invoice: Stripe.Invoice,
    stripeSubscriptionId: string,
    tx: DbClient,
  ): Promise<void> {
    const local = await this.repository.findByStripeId(
      stripeSubscriptionId,
      tx,
    );
    if (!local || local.status === SubscriptionStatus.CANCELLED) return;
    await this.repository.updateSubscription(
      local.id,
      { status: SubscriptionStatus.PAST_DUE },
      tx,
    );
    await this.repository.createEvent(
      {
        userId: local.userId,
        subscriptionId: local.id,
        type: 'payment_failed',
        metadata: {
          invoiceId: invoice.id,
          attemptCount: invoice.attempt_count,
        },
      },
      tx,
    );
  }

  /** Status, cancellation flag and period, from fresh Stripe state. Plan changes come via invoices. */
  private async onSubscriptionSync(
    stripeSub: Stripe.Subscription,
    tx: DbClient,
  ): Promise<void> {
    const local = await this.repository.findByStripeId(stripeSub.id, tx);
    if (!local || local.status === SubscriptionStatus.CANCELLED) return;

    const status = mapStatus(stripeSub.status);
    if (status === SubscriptionStatus.CANCELLED) {
      await this.onSubscriptionEnded(
        stripeSub.id,
        `stripe_status_${stripeSub.status}`,
        tx,
      );
      return;
    }
    const period = subscriptionPeriod(stripeSub);
    await this.repository.updateSubscription(
      local.id,
      {
        ...(status ? { status } : {}),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        ...(period
          ? { currentPeriodStart: period.start, currentPeriodEnd: period.end }
          : {}),
      },
      tx,
    );
  }

  private async onSubscriptionEnded(
    stripeSubscriptionId: string,
    reason: string,
    tx: DbClient,
  ): Promise<void> {
    const local = await this.repository.findByStripeId(
      stripeSubscriptionId,
      tx,
    );
    if (!local || local.status === SubscriptionStatus.CANCELLED) return;
    await this.repository.lockAccount(local.userId, tx);

    await this.repository.updateSubscription(
      local.id,
      {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelAtPeriodEnd: false,
        scheduledPackageId: null,
        scheduledInterval: null,
      },
      tx,
    );
    // Remaining tokens stay usable until their scheduled expiry.
    await this.tokens.startScheduledExpiry(local.userId, tx);
    await this.repository.createEvent(
      {
        userId: local.userId,
        subscriptionId: local.id,
        type: 'cancelled',
        fromPackageId: local.packageId,
        metadata: { reason },
      },
      tx,
    );
  }

  // --- helpers -------------------------------------------------------------------

  /**
   * Locks the billing account of a user Stripe says has paid, creating the
   * account if they never opened billing. Returns false for ids that are not
   * (or no longer) users; checked first because a failed statement would
   * abort the whole transaction.
   */
  private async lockPayingUser(userId: string, tx: DbClient): Promise<boolean> {
    if (!UUID.test(userId) || !(await this.repository.userExists(userId, tx)))
      return false;
    await this.repository.createAccountIfMissing(userId, tx);
    return this.repository.lockAccount(userId, tx);
  }

  private retrieve(id: string): Promise<Stripe.Subscription> {
    return this.stripe.call('webhook.subscription.retrieve', (stripe) =>
      stripe.subscriptions.retrieve(id),
    );
  }

  private async scheduledExpiry(periodEnd: Date): Promise<Date> {
    const { monthsAfterPeriodEnd } = await this.settings.get('token_expiry');
    return addMonths(periodEnd, monthsAfterPeriodEnd);
  }
}

/** Local status for a Stripe status; null = leave unchanged (e.g. `incomplete`). */
export function mapStatus(
  status: Stripe.Subscription.Status,
): SubscriptionStatus | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return SubscriptionStatus.ACTIVE;
    case 'past_due':
    case 'unpaid':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
    case 'incomplete_expired':
      return SubscriptionStatus.CANCELLED;
    default:
      return null;
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription ?? null);
}

/**
 * Price the invoice charges for. Proration invoices hold a credit line for
 * the old price and a charge line for the new one; the largest positive line
 * is the price now in effect.
 */
export function invoicePriceId(invoice: Stripe.Invoice): string | null {
  let best: { amount: number; price: string } | null = null;
  for (const line of invoice.lines?.data ?? []) {
    const price = stripeId(line.pricing?.price_details?.price ?? null);
    if (!price || line.amount <= 0) continue;
    if (!best || line.amount > best.amount)
      best = { amount: line.amount, price };
  }
  return best?.price ?? null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
