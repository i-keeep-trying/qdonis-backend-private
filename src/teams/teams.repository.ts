import { Injectable } from '@nestjs/common';

import type {
  Prisma,
  Team,
  TeamInvitation,
  TeamMember,
} from '../generated/prisma/client';
import { TeamRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type DbClient = Prisma.TransactionClient;

const USER_REF = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} as const satisfies Prisma.UserSelect;

export type TeamWithCount = Team & { _count: { members: number } };

@Injectable()
export class TeamsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { maxWait: 10_000, timeout: 20_000 });
  }

  findUser(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { ...USER_REF, emailVerifiedAt: true },
    });
  }

  findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
  }

  // --- teams -----------------------------------------------------------------

  async createWithOwner(input: {
    name: string;
    ownerId: string;
    tokenLimit: number | null;
  }): Promise<Team> {
    return this.transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name: input.name,
          ownerId: input.ownerId,
          tokenLimit: input.tokenLimit,
        },
      });
      await tx.teamMember.create({
        data: { teamId: team.id, userId: input.ownerId, role: TeamRole.OWNER },
      });
      return team;
    });
  }

  findTeam(id: string): Promise<Team | null> {
    return this.prisma.team.findUnique({ where: { id } });
  }

  findTeamWithCount(id: string): Promise<TeamWithCount | null> {
    return this.prisma.team.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
  }

  /** Teams the user belongs to (owned first), with their role. */
  async listForUser(userId: string) {
    const rows = await this.prisma.teamMember.findMany({
      where: { userId },
      include: { team: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'desc' },
      take: 200,
    });
    return rows.sort(
      (a, b) =>
        Number(b.role === TeamRole.OWNER) - Number(a.role === TeamRole.OWNER),
    );
  }

  async sumLimits(ownerId: string, excludeTeamId?: string): Promise<number> {
    const result = await this.prisma.team.aggregate({
      where: {
        ownerId,
        tokenLimit: { not: null },
        ...(excludeTeamId ? { id: { not: excludeTeamId } } : {}),
      },
      _sum: { tokenLimit: true },
    });
    return result._sum.tokenLimit ?? 0;
  }

  async sumUsedByOwner(ownerId: string): Promise<number> {
    const result = await this.prisma.team.aggregate({
      where: { ownerId },
      _sum: { tokensUsed: true },
    });
    return result._sum.tokensUsed ?? 0;
  }

  updateTeam(
    id: string,
    data: { name?: string; tokenLimit?: number | null },
  ): Promise<Team> {
    return this.prisma.team.update({ where: { id }, data });
  }

  async deleteTeam(id: string): Promise<void> {
    // projects.team_id is ON DELETE SET NULL: team projects become personal.
    await this.prisma.team.deleteMany({ where: { id } });
  }

  // --- members ---------------------------------------------------------------

  findMember(
    teamId: string,
    userId: string,
    db: DbClient = this.prisma,
  ): Promise<TeamMember | null> {
    return db.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
  }

  listMembers(teamId: string) {
    return this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: USER_REF } },
      orderBy: { joinedAt: 'asc' },
      take: 1_000,
    });
  }

  countMembers(teamId: string, db: DbClient = this.prisma): Promise<number> {
    return db.teamMember.count({ where: { teamId } });
  }

  addMember(
    teamId: string,
    userId: string,
    role: TeamRole,
    db: DbClient,
  ): Promise<TeamMember> {
    return db.teamMember.create({ data: { teamId, userId, role } });
  }

  updateMemberRole(
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMember> {
    return this.prisma.teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role },
    });
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.teamMember.deleteMany({
      where: { teamId, userId },
    });
    return count > 0;
  }

  // --- invitations -------------------------------------------------------------

  findInvitationByEmail(
    teamId: string,
    email: string,
  ): Promise<TeamInvitation | null> {
    return this.prisma.teamInvitation.findUnique({
      where: { teamId_email: { teamId, email } },
    });
  }

  upsertInvitation(input: {
    teamId: string;
    email: string;
    role: TeamRole;
    tokenHash: string;
    invitedById: string;
    expiresAt: Date;
  }): Promise<TeamInvitation> {
    const fields = {
      role: input.role,
      tokenHash: input.tokenHash,
      invitedById: input.invitedById,
      expiresAt: input.expiresAt,
      acceptedAt: null,
    };
    return this.prisma.teamInvitation.upsert({
      where: { teamId_email: { teamId: input.teamId, email: input.email } },
      create: { teamId: input.teamId, email: input.email, ...fields },
      update: fields,
    });
  }

  findInvitationByHash(tokenHash: string) {
    return this.prisma.teamInvitation.findUnique({
      where: { tokenHash },
      include: {
        team: { select: { id: true, name: true, ownerId: true } },
        invitedBy: { select: USER_REF },
      },
    });
  }

  findInvitation(teamId: string, id: string): Promise<TeamInvitation | null> {
    return this.prisma.teamInvitation.findFirst({ where: { id, teamId } });
  }

  listPendingInvitations(teamId: string): Promise<TeamInvitation[]> {
    return this.prisma.teamInvitation.findMany({
      where: { teamId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  listPendingForEmail(email: string) {
    return this.prisma.teamInvitation.findMany({
      where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
      include: {
        team: { select: { id: true, name: true } },
        invitedBy: { select: USER_REF },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markInvitationAccepted(id: string, db: DbClient): Promise<boolean> {
    const { count } = await db.teamInvitation.updateMany({
      where: { id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    return count === 1;
  }

  async deleteInvitation(id: string): Promise<void> {
    await this.prisma.teamInvitation.deleteMany({ where: { id } });
  }

  // --- usage -------------------------------------------------------------------

  usageByMember(teamId: string, from?: Date, to?: Date) {
    return this.prisma.teamTokenUsage.groupBy({
      by: ['userId'],
      where: {
        teamId,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      _sum: { tokens: true },
    });
  }

  /**
   * Adds spent tokens to the team counter and the usage log in one go.
   * The counter may exceed the limit by the last call's tokens: calls are
   * gated before they start, and a finished call is always recorded.
   */
  async recordUsage(input: {
    teamId: string;
    userId: string;
    projectId: string | null;
    tokens: number;
    operation: string;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.team.updateMany({
        where: { id: input.teamId },
        data: { tokensUsed: { increment: input.tokens } },
      }),
      this.prisma.teamTokenUsage.create({ data: input }),
    ]);
  }
}
