import { Injectable } from '@nestjs/common';

import type {
  Prisma,
  Project,
  ProjectVersion,
} from '../generated/prisma/client';
import type {
  ProjectActivityType,
  ProjectRole,
  TeamRole,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type DbClient = Prisma.TransactionClient;

/** Every column except the (possibly multi-MB) `data` blob. */
export const PROJECT_META = {
  id: true,
  ownerId: true,
  teamId: true,
  name: true,
  namingStartedAt: true,
  description: true,
  dataBytes: true,
  progressCompleted: true,
  progressTotal: true,
  revision: true,
  lastAccessedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProjectSelect;

const LIST_SELECT = {
  ...PROJECT_META,
  owner: { select: { id: true, name: true, email: true } },
  team: { select: { id: true, name: true } },
} as const satisfies Prisma.ProjectSelect;

export type ProjectMeta = Prisma.ProjectGetPayload<{
  select: typeof PROJECT_META;
}>;
export type ProjectListRow = Prisma.ProjectGetPayload<{
  select: typeof LIST_SELECT;
}>;

export interface AccessContext {
  id: string;
  name: string;
  ownerId: string;
  teamId: string | null;
  member: {
    id: string;
    role: ProjectRole;
    expiresAt: Date | null;
    shareLinkId: string | null;
  } | null;
  teamRole: TeamRole | null;
}

export type ProjectScope = 'all' | 'personal' | 'shared' | 'team';

/** Keeps at most this many snapshots per project. */
export const MAX_VERSIONS = 50;

@Injectable()
export class ProjectsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { maxWait: 10_000, timeout: 30_000 });
  }

  async accessContext(
    projectId: string,
    userId: string,
  ): Promise<AccessContext | null> {
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        teamId: true,
        members: {
          where: { userId },
          select: { id: true, role: true, expiresAt: true, shareLinkId: true },
          take: 1,
        },
        team: {
          select: {
            members: { where: { userId }, select: { role: true }, take: 1 },
          },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      teamId: row.teamId,
      member: row.members[0] ?? null,
      teamRole: row.team?.members[0]?.role ?? null,
    };
  }

  create(
    data: Prisma.ProjectUncheckedCreateInput,
    db: DbClient = this.prisma,
  ): Promise<ProjectMeta> {
    return db.project.create({ data, select: PROJECT_META });
  }

  findMeta(id: string): Promise<ProjectMeta | null> {
    return this.prisma.project.findUnique({
      where: { id },
      select: PROJECT_META,
    });
  }

  findWithData(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<Project | null> {
    return db.project.findUnique({ where: { id } });
  }

  findListRow(id: string): Promise<ProjectListRow | null> {
    return this.prisma.project.findUnique({
      where: { id },
      select: LIST_SELECT,
    });
  }

  /** Projects the user can open: owned, shared with them, or in their teams. */
  async page(params: {
    userId: string;
    scope: ProjectScope;
    teamId?: string;
    search?: string;
    skip: number;
    take: number;
  }): Promise<{
    items: Array<ProjectListRow & { memberRole: ProjectRole | null }>;
    total: number;
  }> {
    const now = new Date();
    const memberOf: Prisma.ProjectWhereInput = {
      members: {
        some: {
          userId: params.userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      },
    };
    const inMyTeams: Prisma.ProjectWhereInput = {
      team: { members: { some: { userId: params.userId } } },
    };
    const scopes: Record<ProjectScope, Prisma.ProjectWhereInput> = {
      all: { OR: [{ ownerId: params.userId }, memberOf, inMyTeams] },
      personal: { ownerId: params.userId, teamId: null },
      shared: { ...memberOf, ownerId: { not: params.userId } },
      team: inMyTeams,
    };
    const where: Prisma.ProjectWhereInput = {
      AND: [
        scopes[params.scope],
        ...(params.teamId ? [{ teamId: params.teamId }] : []),
        ...(params.search
          ? [
              {
                name: { contains: params.search, mode: 'insensitive' as const },
              },
            ]
          : []),
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        select: {
          ...LIST_SELECT,
          members: {
            where: { userId: params.userId },
            select: { role: true, expiresAt: true },
            take: 1,
          },
        },
        orderBy: [{ lastAccessedAt: 'desc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.project.count({ where }),
    ]);
    return {
      items: rows.map(({ members, ...row }) => {
        const m = members[0];
        const active = m && (!m.expiresAt || m.expiresAt > now);
        return { ...row, memberRole: active ? m.role : null };
      }),
      total,
    };
  }

  async pageAll(params: {
    search?: string;
    ownerId?: string;
    skip: number;
    take: number;
  }): Promise<{ items: ProjectListRow[]; total: number }> {
    const where: Prisma.ProjectWhereInput = {
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      ...(params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              {
                owner: {
                  email: { contains: params.search, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.project.count({ where }),
    ]);
    return { items, total };
  }

  updateMeta(
    id: string,
    data: { name?: string; description?: string | null },
  ): Promise<ProjectMeta> {
    return this.prisma.project.update({
      where: { id },
      data,
      select: PROJECT_META,
    });
  }

  /**
   * Compare-and-swap on `revision`. Returns null when another write landed
   * first (the caller answers 409 with the current revision).
   */
  async saveData(
    id: string,
    expectedRevision: number | null,
    update: {
      data: Prisma.InputJsonObject;
      dataBytes: number;
      /** Omitted: the stored progress is kept. */
      progressCompleted?: number;
      progressTotal?: number;
    },
    db: DbClient = this.prisma,
  ): Promise<ProjectMeta | null> {
    const { count } = await db.project.updateMany({
      where: {
        id,
        ...(expectedRevision === null ? {} : { revision: expectedRevision }),
      },
      data: {
        ...update,
        revision: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    });
    if (count === 0) return null;
    return db.project.findUnique({ where: { id }, select: PROJECT_META });
  }

  /** Row-locks a project's data for a server-side read-modify-write. */
  async lockData(
    id: string,
    tx: DbClient,
  ): Promise<{ data: unknown; revision: number } | null> {
    const rows = await tx.$queryRaw<Array<{ data: unknown; revision: number }>>`
      SELECT data, revision FROM projects WHERE id = ${id}::uuid FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** Renames only while the project still has `expected` as its name. */
  async renameIf(id: string, expected: string, name: string): Promise<boolean> {
    const { count } = await this.prisma.project.updateMany({
      where: { id, name: expected },
      data: { name },
    });
    return count === 1;
  }

  /** The generated-name call ended (named or not). */
  async endNaming(id: string): Promise<void> {
    await this.prisma.project.updateMany({
      where: { id, namingStartedAt: { not: null } },
      data: { namingStartedAt: null },
    });
  }

  async touch(projectId: string, userId: string): Promise<void> {
    const at = new Date();
    await this.prisma.$transaction([
      this.prisma.project.updateMany({
        where: { id: projectId },
        data: { lastAccessedAt: at },
      }),
      this.prisma.projectMember.updateMany({
        where: { projectId, userId },
        data: { lastAccessedAt: at },
      }),
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.project.deleteMany({ where: { id } });
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.projectMember.deleteMany({
      where: { projectId, userId },
    });
    return count > 0;
  }

  async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    return Boolean(row);
  }

  // --- versions --------------------------------------------------------------

  async createVersion(
    data: Prisma.ProjectVersionUncheckedCreateInput,
  ): Promise<Omit<ProjectVersion, 'data'>> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.projectVersion.create({
        data,
        omit: { data: true },
      });
      const stale = await tx.projectVersion.findMany({
        where: { projectId: data.projectId },
        orderBy: { createdAt: 'desc' },
        skip: MAX_VERSIONS,
        select: { id: true },
      });
      if (stale.length) {
        await tx.projectVersion.deleteMany({
          where: { id: { in: stale.map((s) => s.id) } },
        });
      }
      return version;
    });
  }

  listVersions(
    projectId: string,
  ): Promise<Array<Omit<ProjectVersion, 'data'>>> {
    return this.prisma.projectVersion.findMany({
      where: { projectId },
      omit: { data: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_VERSIONS,
    });
  }

  findVersion(projectId: string, id: string): Promise<ProjectVersion | null> {
    return this.prisma.projectVersion.findFirst({ where: { id, projectId } });
  }

  // --- activity --------------------------------------------------------------

  async logActivity(
    entry: {
      projectId: string;
      userId: string | null;
      type: ProjectActivityType;
      details?: Prisma.InputJsonObject;
      stage?: string | null;
    },
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.projectActivity.create({
      data: {
        projectId: entry.projectId,
        userId: entry.userId,
        type: entry.type,
        details: entry.details ?? {},
        stage: entry.stage ?? null,
      },
    });
  }

  async pageActivity(params: {
    projectId: string;
    types?: ProjectActivityType[];
    userId?: string;
    skip: number;
    take: number;
  }) {
    const where: Prisma.ProjectActivityWhereInput = {
      projectId: params.projectId,
      ...(params.types?.length ? { type: { in: params.types } } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.projectActivity.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.projectActivity.count({ where }),
    ]);
    return { items, total };
  }
}
