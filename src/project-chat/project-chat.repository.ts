import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
@Injectable()
export class ProjectChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async page(projectId: string, userId: string, skip: number, take: number) {
    const where = { projectId, userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.projectChatMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.projectChatMessage.count({ where }),
    ]);
    return { items, total };
  }

  count(projectId: string, userId: string): Promise<number> {
    return this.prisma.projectChatMessage.count({
      where: { projectId, userId },
    });
  }

  create(data: Prisma.ProjectChatMessageUncheckedCreateInput) {
    return this.prisma.projectChatMessage.create({ data });
  }

  findOne(projectId: string, userId: string, id: string) {
    return this.prisma.projectChatMessage.findFirst({
      where: { id, projectId, userId },
    });
  }

  /** Any message with this id (ids are client-chosen for user messages). */
  exists(id: string): Promise<boolean> {
    return this.prisma.projectChatMessage
      .count({ where: { id } })
      .then((n) => n > 0);
  }

  update(
    id: string,
    data: { content?: string; metadata?: Prisma.InputJsonObject },
  ) {
    return this.prisma.projectChatMessage.update({ where: { id }, data });
  }

  /** Studio chat replies still marked as being written (any project). */
  streamingStudioMessages() {
    return this.prisma.projectChatMessage.findMany({
      where: {
        AND: [
          { metadata: { path: ['studio'], equals: 1 } },
          { metadata: { path: ['status'], equals: 'streaming' } },
        ],
      },
    });
  }

  /** The newest `take` messages, oldest first. */
  async recent(projectId: string, userId: string, take: number) {
    const rows = await this.prisma.projectChatMessage.findMany({
      where: { projectId, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return rows.reverse();
  }

  async clear(projectId: string, userId: string): Promise<number> {
    const { count } = await this.prisma.projectChatMessage.deleteMany({
      where: { projectId, userId },
    });
    return count;
  }

  async deleteOne(
    projectId: string,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.projectChatMessage.deleteMany({
      where: { id, projectId, userId },
    });
    return count > 0;
  }
}
