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
