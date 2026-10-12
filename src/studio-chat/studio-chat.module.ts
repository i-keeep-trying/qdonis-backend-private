import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { DesignModule } from '../design/design.module';
import { ProjectChatModule } from '../project-chat/project-chat.module';
import { ProjectsModule } from '../projects/projects.module';
import { SimulationModule } from '../simulation/simulation.module';
import { SpecsModule } from '../specs/specs.module';
import { StudioStagesModule } from '../studio-stages/studio-stages.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { VisualizationModule } from '../visualization/visualization.module';
import { StudioChatController } from './studio-chat.controller';
import { StudioChatService } from './studio-chat.service';
import { StudioToolsExecutor } from './studio-tools.executor';

/**
 * The Studio chat agent on the server: model steps, the Studio tools run
 * against the stage modules, the conversation in `project_chat_messages`
 * and chat attachments in S3.
 */
@Module({
  imports: [
    AiModule,
    DesignModule,
    ProjectChatModule,
    ProjectsModule,
    SimulationModule,
    SpecsModule,
    StudioStagesModule,
    TopologiesModule,
    VisualizationModule,
  ],
  controllers: [StudioChatController],
  providers: [StudioChatService, StudioToolsExecutor],
})
export class StudioChatModule {}
