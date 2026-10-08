import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { BedrockClient } from './bedrock.client';

@Module({
  imports: [BillingModule, SettingsModule],
  controllers: [AiController],
  providers: [AiService, BedrockClient],
})
export class AiModule {}
