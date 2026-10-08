import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../common/decorators/public.decorator';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { StripeClient } from './stripe/stripe.client';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Stripe → API. Authenticated by the Stripe-Signature HMAC over the raw
 * body (not by our tokens), hence `@Public`. Not throttled: Stripe controls
 * delivery rate and a 429 would only delay billing.
 *
 * 2xx = applied or deliberately ignored. 5xx = Stripe retries (up to 3 days).
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('billing/stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeClient,
    private readonly webhooks: StripeWebhookService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!signature || !request.rawBody) {
      throw AppError.badRequest(
        ErrorCode.InvalidSignature,
        'Missing Stripe signature or body',
      );
    }
    const event = this.stripe.constructEvent(request.rawBody, signature);
    await this.webhooks.handle(event);
    return { received: true };
  }
}
