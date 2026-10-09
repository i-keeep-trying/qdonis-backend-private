import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { bedrockRuntimeProvider } from './bedrock/bedrock-runtime.provider';
import { BedrockClient } from './bedrock/bedrock.client';

@Module({
  imports: [BillingModule, SettingsModule],
  controllers: [AiController],
  providers: [AiService, BedrockClient, bedrockRuntimeProvider],
  // Feature modules (e.g. Studio) build their own Bedrock requests and reuse
  // the balance check and charging in AiService.
  exports: [AiService, BedrockClient],
})
export class AiModule {}
