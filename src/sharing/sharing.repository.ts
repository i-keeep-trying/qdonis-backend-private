import { Injectable } from '@nestjs/common';

import type {
  Prisma,
  ProjectInvitation,
  ProjectMember,
  ShareLink,
} from '../generated/prisma/client';
import type { ProjectRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type DbClient = Prisma.TransactionClient;

export const USER_REF = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} as const satisfies Prisma.UserSelect;

export type UserRef = Prisma.UserGetPayload<{ select: typeof USER_REF }>;

export interface UserForSharing extends UserRef {
  isActive: boolean;
  emailVerifiedAt: Date | null;
}

@Injectable()
export class SharingRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { maxWait: 10_000, timeout: 20_000 });
  }

  findUserByEmail(email: string): Promise<UserForSharing | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { ...USER_REF, isActive: true, emailVerifiedAt: true },
    });
  }

  findUser(id: string): Promise<UserForSharing | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { ...USER_REF, isActive: true, emailVerifiedAt: true },
    });
  }

  // --- members ---------------------------------------------------------------

  findMember(projectId: string, userId: string, db: DbClient = this.prisma) {
    return db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
  }

  findMemberById(projectId: string, id: string) {
    return this.prisma.projectMember.findFirst({
      where: { id, projectId },
      include: { user: { select: USER_REF } },
    });
  }

  upsertMember(
    input: {
      projectId: string;
      userId: string;
      role: ProjectRole;
      grantedById: string | null;
      shareLinkId?: string | null;
    },
    db: DbClient = this.prisma,
  ): Promise<ProjectMember> {
    return db.projectMember.upsert({
      where: {
        projectId_userId: { projectId: input.projectId, userId: input.userId },
      },
      create: {
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        grantedById: input.grantedById,
        shareLinkId: input.shareLinkId ?? null,
      },
      update: {
        role: input.role,
        grantedById: input.grantedById,
        expiresAt: null,
        ...(input.shareLinkId !== undefined
          ? { shareLinkId: input.shareLinkId }
          : {}),
      },
    });
  }

  updateMemberRole(id: string, role: ProjectRole): Promise<ProjectMember> {
    return this.prisma.projectMember.update({ where: { id }, data: { role } });
  }

  async deleteMember(id: string): Promise<void> {
    await this.prisma.projectMember.deleteMany({ where: { id } });
  }

  listMembers(projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: USER_REF },
        grantedBy: { select: USER_REF },
      },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
    });
  }

  // --- invitations ----------------------------------------------------------

  upsertInvitation(input: {
    projectId: string;
    email: string;
    role: ProjectRole;
    tokenHash: string;
    message: string | null;
    invitedById: string;
    expiresAt: Date;
  }): Promise<ProjectInvitation> {
    const fields = {
      role: input.role,
      tokenHash: input.tokenHash,
      message: input.message,
      invitedById: input.invitedById,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      acceptedById: null,
      revokedAt: null,
    };
    return this.prisma.projectInvitation.upsert({
      where: {
        projectId_email: { projectId: input.projectId, email: input.email },
      },
      create: { projectId: input.projectId, email: input.email, ...fields },
      update: fields,
    });
  }

  findInvitationByHash(tokenHash: string) {
    return this.prisma.projectInvitation.findUnique({
      where: { tokenHash },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        invitedBy: { select: USER_REF },
      },
    });
  }

  findInvitation(projectId: string, id: string) {
    return this.prisma.projectInvitation.findFirst({
      where: { id, projectId },
    });
  }

  /** Marks accepted only if still open; false when another request won. */
  async markInvitationAccepted(
    id: string,
    userId: string,
    db: DbClient,
  ): Promise<boolean> {
    const { count } = await db.projectInvitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });
    return count === 1;
  }

  async revokeInvitation(id: string): Promise<void> {
    await this.prisma.projectInvitation.updateMany({
      where: { id, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  listOpenInvitations(projectId: string): Promise<ProjectInvitation[]> {
    return this.prisma.projectInvitation.findMany({
      where: { projectId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  // --- share links ----------------------------------------------------------

  createShareLink(
    data: Prisma.ShareLinkUncheckedCreateInput,
  ): Promise<ShareLink> {
    return this.prisma.shareLink.create({ data });
  }

  findShareLinkByToken(token: string) {
    return this.prisma.shareLink.findUnique({
      where: { token },
      include: { project: { select: { id: true, name: true, ownerId: true } } },
    });
  }

  findShareLink(projectId: string, id: string): Promise<ShareLink | null> {
    return this.prisma.shareLink.findFirst({ where: { id, projectId } });
  }

  listActiveShareLinks(projectId: string): Promise<ShareLink[]> {
    return this.prisma.shareLink.findMany({
      where: { projectId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async deactivateShareLink(id: string): Promise<void> {
    await this.prisma.shareLink.updateMany({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Atomically consumes one use of a link that is still active, unexpired
   * and under its limit. One-time links deactivate on use. False = no use
   * left (another request may have taken the last one).
   */
  async consumeShareLinkUse(id: string, db: DbClient): Promise<boolean> {
    const rows = await db.$executeRaw`
      UPDATE share_links
      SET uses = uses + 1,
          last_used_at = NOW(),
          updated_at = NOW(),
          is_active = CASE WHEN type = 'ONE_TIME_USE' THEN false ELSE is_active END
      WHERE id = ${id}::uuid
        AND is_active = true
        AND (max_uses IS NULL OR uses < max_uses)
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    return rows === 1;
  }
}
