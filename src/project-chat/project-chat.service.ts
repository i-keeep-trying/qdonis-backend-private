import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { Prisma } from '../generated/prisma/client';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ChatPageQueryDto, CreateChatMessageDto } from './dto/chat.dto';
import { ProjectChatRepository } from './project-chat.repository';

const MAX_MESSAGES_PER_USER = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
/**
 * Design-assistant chat history (was Supabase `chat_messages`): each user
 * sees only their own conversation within a project they can access.
 */
@Injectable()
export class ProjectChatService {
  constructor(
    private readonly repository: ProjectChatRepository,
    private readonly access: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ChatPageQueryDto,
  ) {
    await this.access.require(user, projectId);
    const { items, total } = await this.repository.page(
      projectId,
      user.id,
      query.skip,
      query.take,
    );
    return new PaginatedResultDto(items, total, query.skip, query.take);
  }

  async add(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateChatMessageDto,
  ) {
    await this.access.require(user, projectId, 'canComment');
    const metadata = dto.metadata ?? {};
    if (
      Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES
    ) {
      throw AppError.tooLarge(
        ErrorCode.ValidationFailed,
        'metadata is too large (64 KB max)',
      );
    }
    if (
      (await this.repository.count(projectId, user.id)) >= MAX_MESSAGES_PER_USER
    ) {
      throw AppError.conflict(
        ErrorCode.ValidationFailed,
        'Chat history is full; clear it to continue saving messages',
      );
    }
    return this.repository.create({
      projectId,
      userId: user.id,
      sender: dto.sender,
      content: dto.content,
      metadata: metadata as Prisma.InputJsonObject,
    });
  }

  async clear(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ deleted: number }> {
    await this.access.require(user, projectId);
    return { deleted: await this.repository.clear(projectId, user.id) };
  }

  async remove(
    user: AuthenticatedUser,
    projectId: string,
    messageId: string,
  ): Promise<void> {
    await this.access.require(user, projectId);
    if (!(await this.repository.deleteOne(projectId, user.id, messageId))) {
      throw AppError.notFound(
        ErrorCode.ChatMessageNotFound,
        'Message not found',
      );
    }
  }
}
