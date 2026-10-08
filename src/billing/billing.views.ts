import type {
  AddonPackage,
  Plan,
  PlanPackage,
  SubscriptionEvent,
  TokenBatch,
  TokenLedgerEntry,
} from '../generated/prisma/client';
import type { SubscriptionWithPlan } from './billing.repository';
import { periodTokens } from './catalog.service';
import type { BillingOverview } from './subscriptions.service';

/**
 * Explicit response shapes. Built field by field so new columns never leak
 * into the API by accident.
 */

export function packageView(pkg: PlanPackage, includeStripe = false) {
  return {
    id: pkg.id,
    planId: pkg.planId,
    name: pkg.name,
    tokenAllocation: pkg.tokenAllocation,
    monthlyPriceCents: pkg.monthlyPriceCents,
    yearlyPriceCents: pkg.yearlyPriceCents,
    availableMonthly: Boolean(pkg.stripePriceIdMonthly),
    availableYearly: Boolean(pkg.stripePriceIdYearly),
    isDefault: pkg.isDefault,
    sortOrder: pkg.sortOrder,
    ...(includeStripe
      ? {
          isActive: pkg.isActive,
          stripePriceIdMonthly: pkg.stripePriceIdMonthly,
          stripePriceIdYearly: pkg.stripePriceIdYearly,
        }
      : {}),
  };
}

export function planView(
  plan: Plan & { packages?: PlanPackage[] },
  includeStripe = false,
) {
  return {
    id: plan.id,
    name: plan.name,
    tier: plan.tier,
    features: Array.isArray(plan.features) ? plan.features : [],
    isPopular: plan.isPopular,
    isContactOnly: plan.isContactOnly,
    sortOrder: plan.sortOrder,
    ...(includeStripe ? { isActive: plan.isActive } : {}),
    packages: (plan.packages ?? []).map((pkg) =>
      packageView(pkg, includeStripe),
    ),
  };
}

export function addonView(addon: AddonPackage, includeStripe = false) {
  return {
    id: addon.id,
    name: addon.name,
    description: addon.description,
    tokenAmount: addon.tokenAmount,
    priceCents: addon.priceCents,
    sortOrder: addon.sortOrder,
    ...(includeStripe
      ? { isActive: addon.isActive, stripePriceId: addon.stripePriceId }
      : {}),
  };
}

export function subscriptionView(sub: SubscriptionWithPlan | null) {
  if (!sub) return null;
  return {
    id: sub.id,
    status: sub.status,
    plan: { id: sub.plan.id, name: sub.plan.name, tier: sub.plan.tier },
    package: sub.package
      ? { id: sub.package.id, name: sub.package.name }
      : null,
    interval: sub.interval,
    tokenAllocation: sub.tokenAllocation,
    isPaid: Boolean(sub.stripeSubscriptionId),
    managedBy: sub.stripeSubscriptionId ? 'stripe' : 'manual',
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    scheduledChange: sub.scheduledPackage
      ? {
          package: {
            id: sub.scheduledPackage.id,
            name: sub.scheduledPackage.name,
          },
          interval: sub.scheduledInterval,
          tokenAllocation: sub.scheduledInterval
            ? periodTokens(sub.scheduledPackage, sub.scheduledInterval)
            : sub.scheduledPackage.tokenAllocation,
          effectiveAt: sub.currentPeriodEnd,
        }
      : null,
  };
}

export function batchView(batch: TokenBatch) {
  return {
    id: batch.id,
    source: batch.source,
    tokensGranted: batch.tokensGranted,
    tokensUsed: batch.tokensUsed,
    tokensRemaining: batch.tokensGranted - batch.tokensUsed,
    grantedAt: batch.grantedAt,
    expiresAt: batch.expiresAt,
    scheduledExpiryAt: batch.scheduledExpiryAt,
    note: batch.note,
  };
}

export function overviewView(overview: BillingOverview) {
  const expiring = overview.batches
    .filter((batch) => batch.expiresAt !== null)
    .reduce((sum, batch) => sum + batch.tokensGranted - batch.tokensUsed, 0);
  const nextExpiry =
    overview.batches.find((batch) => batch.expiresAt !== null)?.expiresAt ??
    null;
  return {
    subscription: subscriptionView(overview.subscription),
    balance: overview.balance,
    expiringTokens: expiring,
    nextExpiryAt: nextExpiry,
    batches: overview.batches.map(batchView),
    trialGrantedAt: overview.trialGrantedAt,
    canManageBilling: overview.hasStripeCustomer,
  };
}

export function ledgerView(entry: TokenLedgerEntry) {
  return {
    id: entry.id,
    amount: entry.amount,
    reason: entry.reason,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
  };
}

export function eventView(event: SubscriptionEvent) {
  return {
    id: event.id,
    type: event.type,
    fromPackageId: event.fromPackageId,
    toPackageId: event.toPackageId,
    tokensDelta: event.tokensDelta,
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
}
