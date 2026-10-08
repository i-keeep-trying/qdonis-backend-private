import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';

@Module({
  // Logging every probe would drown out real traffic in the logs.
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
})
export class HealthModule {}
