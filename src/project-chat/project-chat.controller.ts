import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatPageQueryDto, CreateChatMessageDto } from './dto/chat.dto';
import { ProjectChatService } from './project-chat.service';
@ApiTags('project chat')
@ApiBearerAuth()
@Controller('projects/:projectId/chat')
export class ProjectChatController {
  constructor(private readonly chat: ProjectChatService) {}

  @Get()
  @ApiOperation({ summary: 'My chat history in this project (oldest first)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ChatPageQueryDto,
  ) {
    return this.chat.list(user, projectId, query);
  }

  @Post()
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateChatMessageDto,
  ) {
    return this.chat.add(user, projectId, dto);
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my chat history in this project' })
  clear(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.chat.clear(user, projectId);
  }

  @Delete(':messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<void> {
    return this.chat.remove(user, projectId, messageId);
  }
}
