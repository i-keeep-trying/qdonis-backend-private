import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { ProjectsModule } from '../projects/projects.module';
import { TeamsModule } from '../teams/teams.module';
import { AiStepRunner } from './ai/ai-step.runner';
import { SpecDocumentsService } from './ai/spec-documents.service';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';

/**
 * Lifecycle steps that do not depend on the simulation core (design intent,
 * requirements, specs/constraints, topology recommendation, naming). Exports
 * the AI step runner and document resolution for the other step modules.
 */
@Module({
  imports: [AiModule, ProjectsModule, TeamsModule],
  controllers: [DesignController],
  providers: [AiStepRunner, SpecDocumentsService, DesignService],
  exports: [AiStepRunner, SpecDocumentsService],
})
export class DesignModule {}
