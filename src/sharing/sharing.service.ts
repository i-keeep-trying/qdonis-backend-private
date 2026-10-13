import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthenticatedUser } from '../auth/auth.types';
import {
  hashOpaqueToken,
  newOpaqueToken,
  OPAQUE_TOKEN_PATTERN,
} from '../common/crypto/opaque-token';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import type { AppConfiguration } from '../config/configuration';
import type { ShareLink } from '../generated/prisma/client';
import {
  ProjectActivityType,
  ProjectRole,
  ShareLinkType,
} from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import { ProjectAccessService } from '../projects/project-access.service';
import type {
  EffectiveRole,
  ProjectAccess,
} from '../projects/project-permissions';
import { higherRole } from '../projects/project-permissions';
import { ProjectsRepository } from '../projects/projects.repository';
import { PasswordHasher } from '../users/password-hasher.service';
import type {
  CreateInvitationsDto,
  CreateShareLinkDto,
} from './dto/sharing.dto';
import { SharingRepository, type UserRef } from './sharing.repository';

type Actor = Pick<AuthenticatedUser, 'id' | 'role' | 'email'>;

const MAX_LINK_LIFETIME_MS = 366 * 86_400_000;

export interface InvitationResult {
  email: string;
  status: 'shared' | 'invited' | 'failed';
  error?: string;
}

export interface ShareLinkView {
  id: string;
  url: string;
  type: ShareLinkType;
  role: ProjectRole;
  hasPassword: boolean;
  allowedDomains: string[];
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface JoinResult {
  projectId: string;
  projectName: string;
  role: EffectiveRole;
}

const personName = (u: Pick<UserRef, 'name' | 'email'> | null): string =>
  u?.name?.trim() || u?.email.split('@')[0] || 'Someone';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Project sharing: direct shares, email invitations and share links (port of
 * the old `SharingService`, with authorisation, hashing and atomic usage
 * accounting done server-side).
 */
@Injectable()
export class SharingService {
  private readonly logger = new Logger(SharingService.name);

  constructor(
    private readonly repository: SharingRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly hasher: PasswordHasher,
    private readonly mail: MailService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  // --- invitations ------------------------------------------------------------

  /**
   * Registered users get access immediately (and a notice); everyone else
   * gets an email invitation. Each address is handled independently, so one
   * bad address never blocks the rest.
   */
  async invite(
    actor: Actor,
    projectId: string,
    dto: CreateInvitationsDto,
  ): Promise<{ results: InvitationResult[] }> {
    const access = await this.access.require(actor, projectId, 'canShare');
    if (dto.role === ProjectRole.ADMIN && !access.isOwner) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only the owner can make someone a project admin',
      );
    }
    const inviter = await this.repository.findUser(actor.id);
    const inviterName = personName(inviter);
    const results: InvitationResult[] = [];

    for (const email of dto.emails) {
      try {
        results.push(
          await this.inviteOne(actor, access, email, dto, inviterName),
        );
      } catch (error) {
        this.logger.warn(
          `Invitation to project ${projectId} failed: ${describe(error)}`,
        );
        results.push({
          email,
          status: 'failed',
          error: 'Could not invite this address',
        });
      }
    }
    return { results };
  }

  private async inviteOne(
    actor: Actor,
    access: ProjectAccess,
    email: string,
    dto: CreateInvitationsDto,
    inviterName: string,
  ): Promise<InvitationResult> {
    const projectId = access.projectId;
    const user = await this.repository.findUserByEmail(email);

    if (user && user.isActive) {
      if (user.id === access.ownerId) {
        return {
          email,
          status: 'failed',
          error: 'This person owns the project',
        };
      }
      const existing = await this.repository.findMember(projectId, user.id);
      if (existing?.role === ProjectRole.ADMIN && !access.isOwner) {
        return {
          email,
          status: 'failed',
          error: 'Only the owner can change a project admin',
        };
      }
      await this.repository.upsertMember({
        projectId,
        userId: user.id,
        role: dto.role,
        grantedById: actor.id,
      });
      await this.projects.logActivity({
        projectId,
        userId: actor.id,
        type: ProjectActivityType.ACCESS_GRANTED,
        details: {
          email,
          role: dto.role,
          via: existing ? 'direct_share_updated' : 'direct_share',
        },
      });
      this.mail.dispatch(
        () =>
          this.mail.sendProjectShared({
            to: email,
            name: user.name,
            projectId,
            projectName: access.projectName,
            inviterName,
            role: dto.role,
            message: dto.message,
          }),
        'project-shared',
      );
      return { email, status: 'shared' };
    }

    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + dto.expiresInDays * 86_400_000);
    await this.repository.upsertInvitation({
      projectId,
      email,
      role: dto.role,
      tokenHash: hashOpaqueToken(token),
      message: dto.message || null,
      invitedById: actor.id,
      expiresAt,
    });
    await this.projects.logActivity({
      projectId,
      userId: actor.id,
      type: ProjectActivityType.INVITE,
      details: { email, role: dto.role },
    });
    this.mail.dispatch(
      () =>
        this.mail.sendProjectInvitation({
          to: email,
          projectName: access.projectName,
          inviterName,
          role: dto.role,
          token,
          message: dto.message,
          expiresAt,
        }),
      'project-invitation',
    );
    return { email, status: 'invited' };
  }

  /** Public preview for the accept page. */
  async previewInvitation(token: string) {
    const invitation = await this.loadInvitation(token);
    this.assertInvitationOpen(invitation);
    return {
      projectId: invitation.project.id,
      projectName: invitation.project.name,
      email: invitation.email,
      role: invitation.role,
      inviterName: personName(invitation.invitedBy),
      message: invitation.message,
      expiresAt: invitation.expiresAt,
    };
  }

  async acceptInvitation(actor: Actor, token: string): Promise<JoinResult> {
    const invitation = await this.loadInvitation(token);
    const project = invitation.project;

    if (invitation.acceptedAt) {
      if (invitation.acceptedById === actor.id) {
        const access = await this.access.require(actor, project.id);
        return {
          projectId: project.id,
          projectName: project.name,
          role: access.role,
        };
      }
      throw AppError.conflict(
        ErrorCode.InvitationAlreadyAccepted,
        'This invitation has already been used',
      );
    }
    this.assertInvitationOpen(invitation);

    const user = await this.repository.findUser(actor.id);
    if (!user || user.email !== invitation.email) {
      throw AppError.forbidden(
        ErrorCode.InvitationEmailMismatch,
        'This invitation was sent to a different email address',
      );
    }
    if (!user.emailVerifiedAt) {
      throw AppError.forbidden(
        ErrorCode.EmailNotVerified,
        'Verify your email address before accepting invitations',
      );
    }

    const role = await this.repository.transaction(async (tx) => {
      if (
        !(await this.repository.markInvitationAccepted(
          invitation.id,
          actor.id,
          tx,
        ))
      ) {
        throw AppError.conflict(
          ErrorCode.InvitationAlreadyAccepted,
          'This invitation has already been used',
        );
      }
      if (project.ownerId === actor.id) return 'OWNER' as const;
      const existing = await this.repository.findMember(
        project.id,
        actor.id,
        tx,
      );
      // Accepting never downgrades an existing, higher share.
      const granted =
        existing && higherRole(existing.role, invitation.role) === existing.role
          ? existing.role
          : invitation.role;
      await this.repository.upsertMember(
        {
          projectId: project.id,
          userId: actor.id,
          role: granted,
          grantedById: invitation.invitedById,
          shareLinkId: null,
        },
        tx,
      );
      await this.projects.logActivity(
        {
          projectId: project.id,
          userId: actor.id,
          type: ProjectActivityType.ACCESS_GRANTED,
          details: {
            email: invitation.email,
            role: granted,
            via: 'invitation',
          },
        },
        tx,
      );
      return granted;
    });
    return { projectId: project.id, projectName: project.name, role };
  }

  async revokeInvitation(
    actor: Actor,
    projectId: string,
    invitationId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, 'canShare');
    const invitation = await this.repository.findInvitation(
      projectId,
      invitationId,
    );
    if (!invitation) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invitation not found',
      );
    }
    if (invitation.acceptedAt) {
      throw AppError.conflict(
        ErrorCode.InvitationAlreadyAccepted,
        'This invitation was already accepted; remove the collaborator instead',
      );
    }
    await this.repository.revokeInvitation(invitationId);
  }

  private async loadInvitation(token: string) {
    if (!OPAQUE_TOKEN_PATTERN.test(token)) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invalid invitation',
      );
    }
    const invitation = await this.repository.findInvitationByHash(
      hashOpaqueToken(token),
    );
    if (!invitation) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invalid invitation',
      );
    }
    return invitation;
  }

  private assertInvitationOpen(invitation: {
    acceptedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): void {
    if (invitation.revokedAt) {
      throw AppError.badRequest(
        ErrorCode.InvitationRevoked,
        'This invitation has been revoked',
      );
    }
    if (invitation.acceptedAt) {
      throw AppError.conflict(
        ErrorCode.InvitationAlreadyAccepted,
        'This invitation has already been used',
      );
    }
    if (invitation.expiresAt <= new Date()) {
      throw AppError.badRequest(
        ErrorCode.InvitationExpired,
        'This invitation has expired',
      );
    }
  }

  // --- share links ------------------------------------------------------------

  async createShareLink(
    actor: Actor,
    projectId: string,
    dto: CreateShareLinkDto,
  ): Promise<ShareLinkView> {
    await this.access.require(actor, projectId, 'canShare');
    const now = Date.now();
    if (dto.expiresAt) {
      const at = dto.expiresAt.getTime();
      if (at <= now) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          'expiresAt must be in the future',
        );
      }
      if (at > now + MAX_LINK_LIFETIME_MS) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          'expiresAt must be within a year',
        );
      }
    }
    const isPassword = dto.type === ShareLinkType.PASSWORD_PROTECTED;
    if (isPassword !== Boolean(dto.password)) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        isPassword
          ? 'A password is required for a password-protected link'
          : 'password is only allowed for PASSWORD_PROTECTED links',
      );
    }
    const isDomain = dto.type === ShareLinkType.DOMAIN_RESTRICTED;
    const domains = dto.allowedDomains ?? [];
    if (isDomain !== domains.length > 0) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        isDomain
          ? 'List at least one allowed email domain'
          : 'allowedDomains is only allowed for DOMAIN_RESTRICTED links',
      );
    }

    const passwordHash = dto.password
      ? await this.hasher.hash(dto.password)
      : null;
    const maxUses =
      dto.type === ShareLinkType.ONE_TIME_USE ? 1 : (dto.maxUses ?? null);

    let link: ShareLink | null = null;
    for (let attempt = 0; attempt < 3 && !link; attempt += 1) {
      try {
        link = await this.repository.createShareLink({
          projectId,
          token: newOpaqueToken(),
          type: dto.type,
          role: dto.role,
          allowedDomains: domains,
          passwordHash,
          maxUses,
          expiresAt: dto.expiresAt ?? null,
          createdById: actor.id,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    if (!link) throw new Error('Could not generate a unique share-link token');

    await this.projects.logActivity({
      projectId,
      userId: actor.id,
      type: ProjectActivityType.SHARE,
      details: { link_type: dto.type, role: dto.role },
    });
    return this.linkView(link);
  }

  async deactivateShareLink(
    actor: Actor,
    projectId: string,
    linkId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, 'canShare');
    const link = await this.repository.findShareLink(projectId, linkId);
    if (!link)
      throw AppError.notFound(
        ErrorCode.ShareLinkNotFound,
        'Share link not found',
      );
    await this.repository.deactivateShareLink(linkId);
  }

  /** Public preview: what opening the link grants, and what it needs. */
  async previewShareLink(token: string) {
    const link = await this.loadLink(token);
    this.assertLinkUsable(link);
    return {
      projectId: link.project.id,
      projectName: link.project.name,
      role: link.role,
      type: link.type,
      requiresPassword: link.type === ShareLinkType.PASSWORD_PROTECTED,
      allowedDomains:
        link.type === ShareLinkType.DOMAIN_RESTRICTED
          ? link.allowedDomains
          : [],
      expiresAt: link.expiresAt,
    };
  }

  /**
   * Joins a project through a link. Owners and existing collaborators are let
   * through without consuming a use; otherwise one use is consumed atomically.
   */
  async accessShareLink(
    actor: Actor,
    token: string,
    password?: string,
  ): Promise<JoinResult> {
    const link = await this.loadLink(token);
    const project = link.project;

    if (project.ownerId === actor.id) {
      return {
        projectId: project.id,
        projectName: project.name,
        role: 'OWNER',
      };
    }
    const existing = await this.repository.findMember(project.id, actor.id);
    if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
      return {
        projectId: project.id,
        projectName: project.name,
        role: existing.role,
      };
    }

    this.assertLinkUsable(link);

    if (link.type === ShareLinkType.DOMAIN_RESTRICTED) {
      const user = await this.repository.findUser(actor.id);
      const domain = user?.email.split('@')[1]?.toLowerCase();
      if (
        !user?.emailVerifiedAt ||
        !domain ||
        !link.allowedDomains.includes(domain)
      ) {
        throw AppError.forbidden(
          ErrorCode.ShareLinkDomainRestricted,
          `This link is only available to verified users from: ${link.allowedDomains.join(', ')}`,
        );
      }
    }
    if (link.type === ShareLinkType.PASSWORD_PROTECTED) {
      if (!password) {
        throw AppError.forbidden(
          ErrorCode.ShareLinkPasswordRequired,
          'Password required',
        );
      }
      if (!(await this.hasher.verify(link.passwordHash, password))) {
        throw AppError.forbidden(
          ErrorCode.ShareLinkPasswordInvalid,
          'Incorrect password',
        );
      }
    }

    await this.repository.transaction(async (tx) => {
      if (!(await this.repository.consumeShareLinkUse(link.id, tx))) {
        throw AppError.badRequest(
          ErrorCode.ShareLinkExhausted,
          'This share link is no longer available',
        );
      }
      await this.repository.upsertMember(
        {
          projectId: project.id,
          userId: actor.id,
          role: link.role,
          grantedById: link.createdById,
          shareLinkId: link.id,
        },
        tx,
      );
      await this.projects.logActivity(
        {
          projectId: project.id,
          userId: actor.id,
          type: ProjectActivityType.ACCESS_GRANTED,
          details: {
            via: 'share_link',
            link_type: link.type,
            role: link.role,
            email: actor.email,
          },
        },
        tx,
      );
    });
    return {
      projectId: project.id,
      projectName: project.name,
      role: link.role,
    };
  }

  private async loadLink(token: string) {
    if (!OPAQUE_TOKEN_PATTERN.test(token)) {
      throw AppError.notFound(
        ErrorCode.ShareLinkNotFound,
        'Invalid share link',
      );
    }
    const link = await this.repository.findShareLinkByToken(token);
    if (!link)
      throw AppError.notFound(
        ErrorCode.ShareLinkNotFound,
        'Invalid share link',
      );
    return link;
  }

  private assertLinkUsable(link: ShareLink): void {
    if (!link.isActive) {
      throw AppError.badRequest(
        ErrorCode.ShareLinkInactive,
        'This share link has been deactivated',
      );
    }
    if (link.expiresAt && link.expiresAt <= new Date()) {
      throw AppError.badRequest(
        ErrorCode.ShareLinkExpired,
        'This share link has expired',
      );
    }
    if (link.maxUses !== null && link.uses >= link.maxUses) {
      throw AppError.badRequest(
        ErrorCode.ShareLinkExhausted,
        'This share link has reached its usage limit',
      );
    }
  }

  private linkView(link: ShareLink): ShareLinkView {
    const { frontendUrl } = this.config.get('app', { infer: true });
    return {
      id: link.id,
      url: `${frontendUrl}/share/${link.token}`,
      type: link.type,
      role: link.role,
      hasPassword: link.passwordHash !== null,
      allowedDomains: link.allowedDomains,
      maxUses: link.maxUses,
      uses: link.uses,
      expiresAt: link.expiresAt,
      isActive: link.isActive,
      lastUsedAt: link.lastUsedAt,
      createdAt: link.createdAt,
    };
  }

  // --- collaborators ------------------------------------------------------------

  /**
   * Who can access the project. Invitations and links are shown only to
   * people who can share (they reveal tokens and email addresses).
   */
  async collaborators(actor: Actor, projectId: string) {
    const access = await this.access.require(actor, projectId);
    const [owner, members] = await Promise.all([
      this.repository.findUser(access.ownerId),
      this.repository.listMembers(projectId),
    ]);
    const canShare = access.permissions.canShare;
    const [invitations, links] = canShare
      ? await Promise.all([
          this.repository.listOpenInvitations(projectId),
          this.repository.listActiveShareLinks(projectId),
        ])
      : [[], []];
    const now = new Date();
    return {
      owner: owner
        ? {
            id: owner.id,
            name: owner.name,
            email: owner.email,
            avatarUrl: owner.avatarUrl,
          }
        : null,
      collaborators: members.map((m) => ({
        id: m.id,
        user: m.user,
        role: m.role,
        via: m.shareLinkId ? 'link_share' : 'direct_share',
        grantedBy: m.grantedBy,
        joinedAt: m.createdAt,
        lastAccessedAt: m.lastAccessedAt,
        expiresAt: m.expiresAt,
        isExpired: Boolean(m.expiresAt && m.expiresAt <= now),
      })),
      pendingInvitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.expiresAt <= now ? 'expired' : 'pending',
        sentAt: i.updatedAt,
        expiresAt: i.expiresAt,
      })),
      activeLinks: links.map((l) => this.linkView(l)),
    };
  }

  async updateMemberRole(
    actor: Actor,
    projectId: string,
    memberId: string,
    role: ProjectRole,
  ) {
    const access = await this.access.require(actor, projectId, 'canShare');
    const member = await this.repository.findMemberById(projectId, memberId);
    if (!member)
      throw AppError.notFound(
        ErrorCode.MemberNotFound,
        'Collaborator not found',
      );
    if (member.userId === actor.id) {
      throw AppError.forbidden(
        ErrorCode.SelfModification,
        'You cannot change your own role',
      );
    }
    if (
      (role === ProjectRole.ADMIN || member.role === ProjectRole.ADMIN) &&
      !access.isOwner
    ) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only the owner can grant or change the admin role',
      );
    }
    const updated = await this.repository.updateMemberRole(memberId, role);
    if (member.role !== role) {
      await this.projects.logActivity({
        projectId,
        userId: actor.id,
        type: ProjectActivityType.ROLE_CHANGED,
        details: {
          new_role: role,
          old_role: member.role,
          email: member.user.email,
        },
      });
    }
    return { id: updated.id, role: updated.role };
  }

  /** Revoke someone's access, or leave the project yourself. */
  async removeMember(
    actor: Actor,
    projectId: string,
    memberId: string,
  ): Promise<void> {
    const access = await this.access.require(actor, projectId);
    const member = await this.repository.findMemberById(projectId, memberId);
    if (!member)
      throw AppError.notFound(
        ErrorCode.MemberNotFound,
        'Collaborator not found',
      );
    const self = member.userId === actor.id;
    if (!self) {
      if (!access.permissions.canShare) {
        throw AppError.forbidden(
          ErrorCode.Forbidden,
          'Only the owner or a project admin can remove collaborators',
        );
      }
      if (member.role === ProjectRole.ADMIN && !access.isOwner) {
        throw AppError.forbidden(
          ErrorCode.Forbidden,
          'Only the owner can remove a project admin',
        );
      }
    }
    await this.repository.deleteMember(memberId);
    await this.projects.logActivity({
      projectId,
      userId: actor.id,
      type: ProjectActivityType.ACCESS_REVOKED,
      details: {
        email: member.user.email,
        via: self ? 'left_project' : 'revoked',
      },
    });
  }
}
