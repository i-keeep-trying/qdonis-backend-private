import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import type { AppConfiguration } from '../../config/configuration';

/**
 * Pinned so a Stripe dashboard upgrade can never change the payload shapes
 * this code parses. Bump deliberately, together with the `stripe` package.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive' as const;

/**
 * Owns the Stripe SDK instance. Every call goes through {@link call}, which
 * turns Stripe failures into stable API errors instead of leaking SDK
 * messages or surfacing as 500s.
 */
@Injectable()
export class StripeClient {
  private readonly logger = new Logger(StripeClient.name);
  private instance?: Stripe;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  isConfigured(): boolean {
    const { secretKey, webhookSecret } = this.config.get('stripe', {
      infer: true,
    });
    return Boolean(secretKey && webhookSecret);
  }

  get api(): Stripe {
    const { secretKey } = this.config.get('stripe', { infer: true });
    if (!secretKey || !this.isConfigured()) {
      throw AppError.unavailable(
        ErrorCode.BillingNotConfigured,
        'Billing is not configured on this server',
      );
    }
    this.instance ??= new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'qdonis-backend' },
    });
    return this.instance;
  }

  /** Verifies the `Stripe-Signature` header and parses the event. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const { webhookSecret } = this.config.get('stripe', { infer: true });
    if (!webhookSecret) {
      throw AppError.unavailable(
        ErrorCode.BillingNotConfigured,
        'Billing is not configured',
      );
    }
    try {
      // 5-minute tolerance (Stripe default) rejects replayed deliveries.
      return this.api.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
        300,
      );
    } catch {
      throw AppError.badRequest(
        ErrorCode.InvalidSignature,
        'Invalid Stripe signature',
      );
    }
  }

  /**
   * Runs a Stripe request. Card declines become 402 PAYMENT_FAILED; other
   * request errors become 502 with a generic message (details logged).
   */
  async call<T>(
    label: string,
    request: (stripe: Stripe) => Promise<T>,
  ): Promise<T> {
    const stripe = this.api;
    try {
      return await request(stripe);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        throw AppError.paymentRequired(
          ErrorCode.PaymentFailed,
          error.message || 'Your card was declined',
        );
      }
      if (error instanceof Stripe.errors.StripeError) {
        this.logger.error(
          `Stripe ${label} failed: ${error.type} ${error.code ?? ''} ${error.message}`,
        );
        throw AppError.badGateway(
          ErrorCode.StripeError,
          'The payment provider could not complete the request; try again',
        );
      }
      throw error;
    }
  }
}

/** Id of an expandable Stripe field (string id or expanded object). */
export function stripeId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Billing period of a subscription (stored on its first item since API 2025-03). */
export function subscriptionPeriod(subscription: Stripe.Subscription): {
  start: Date;
  end: Date;
  priceId: string | null;
} | null {
  const item = subscription.items.data[0];
  if (!item) return null;
  return {
    start: new Date(item.current_period_start * 1000),
    end: new Date(item.current_period_end * 1000),
    priceId: stripeId(item.price),
  };
}
