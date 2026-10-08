import { Module } from '@nestjs/common';

import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

@Module({
  providers: [SettingsRepository, SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
