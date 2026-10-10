import { Module } from '@nestjs/common';

import { AdminProjectsController } from './admin-projects.controller';
import { ProjectAccessService } from './project-access.service';
import { ProjectFilesController } from './project-files.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [
    ProjectsController,
    ProjectFilesController,
    AdminProjectsController,
  ],
  providers: [ProjectsRepository, ProjectAccessService, ProjectsService],
  exports: [ProjectsRepository, ProjectAccessService, ProjectsService],
})
export class ProjectsModule {}
