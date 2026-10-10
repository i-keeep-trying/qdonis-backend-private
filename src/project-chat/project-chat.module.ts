import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { ProjectChatController } from './project-chat.controller';
import { ProjectChatRepository } from './project-chat.repository';
import { ProjectChatService } from './project-chat.service';
@Module({
  imports: [ProjectsModule],
  controllers: [ProjectChatController],
  providers: [ProjectChatRepository, ProjectChatService],
})
export class ProjectChatModule {}
