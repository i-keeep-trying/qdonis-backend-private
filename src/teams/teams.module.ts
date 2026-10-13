import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { TeamsController } from './teams.controller';
import { TeamsRepository } from './teams.repository';
import { TeamsService } from './teams.service';

@Module({
  imports: [BillingModule],
  controllers: [TeamsController],
  providers: [TeamsRepository, TeamsService],
  exports: [TeamsRepository],
})
export class TeamsModule {}
