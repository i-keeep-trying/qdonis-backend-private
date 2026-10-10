import { Module } from '@nestjs/common';

import { AdminProjectsController } from './admin-projects.controller';
import { ProjectAccessService } from './project-access.service';
import { ProjectFilesController } from './project-files.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';
import { StudioGraphController } from './studio-graph.controller';
import { StudioGraphRepository } from './studio/studio-graph.repository';
import { StudioGraphService } from './studio/studio-graph.service';

@Module({
  controllers: [
    ProjectsController,
    ProjectFilesController,
    AdminProjectsController,
    StudioGraphController,
  ],
  providers: [
    ProjectsRepository,
    ProjectAccessService,
    ProjectsService,
    StudioGraphRepository,
    StudioGraphService,
  ],
  exports: [
    ProjectsRepository,
    ProjectAccessService,
    ProjectsService,
    StudioGraphService,
  ],
})
export class ProjectsModule {}
