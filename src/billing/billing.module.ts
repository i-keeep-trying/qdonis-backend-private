import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { BillingAdminService } from './billing-admin.service';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { CatalogService } from './catalog.service';
import { StripeClient } from './stripe/stripe.client';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { SubscriptionsService } from './subscriptions.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [SettingsModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [
    BillingRepository,
    StripeClient,
    TokensService,
    CatalogService,
    SubscriptionsService,
    StripeWebhookService,
    BillingAdminService,
  ],
  exports: [
    BillingAdminService,
    CatalogService,
    SubscriptionsService,
    TokensService,
  ],
})
export class BillingModule {}
