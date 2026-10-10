import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { UsersModule } from '../users/users.module';
import {
  ProjectSharingController,
  SharingTokensController,
} from './sharing.controller';
import { SharingRepository } from './sharing.repository';
import { SharingService } from './sharing.service';

@Module({
  imports: [ProjectsModule, UsersModule],
  controllers: [ProjectSharingController, SharingTokensController],
  providers: [SharingRepository, SharingService],
})
export class SharingModule {}
