import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { StudioAgentService } from './agent/studio-agent.service';
import { StudioController } from './studio.controller';

/**
 * Chat-first Studio (migrated from qdonis-core). The agent step runs here;
 * the stage tools it calls are still executed by the frontend.
 */
@Module({
  imports: [AiModule, TopologiesModule],
  controllers: [StudioController],
  providers: [StudioAgentService],
})
export class StudioModule {}
