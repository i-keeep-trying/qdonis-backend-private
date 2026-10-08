import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [UsersModule, BillingModule, SettingsModule],
  controllers: [AdminController],
})
export class AdminModule {}
