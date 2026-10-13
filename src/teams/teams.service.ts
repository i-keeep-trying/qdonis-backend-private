import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { SubscriptionsService } from '../billing/subscriptions.service';
import {
  hashOpaqueToken,
  newOpaqueToken,
  OPAQUE_TOKEN_PATTERN,
} from '../common/crypto/opaque-token';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import type { Team } from '../generated/prisma/client';
import {
  PlanTier,
  SubscriptionStatus,
  TeamRole,
} from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import type {
  CreateTeamDto,
  InviteTeamMemberDto,
  TeamUsageQueryDto,
  UpdateTeamDto,
} from './dto/team.dto';
import { TeamsRepository } from './teams.repository';

type Actor = Pick<AuthenticatedUser, 'id' | 'email'>;

/** Plans that include teams (old: the Collaborate / `teams` plan). */
const TEAM_TIERS: PlanTier[] = [PlanTier.TEAMS, PlanTier.ENTERPRISE];
const INVITATION_TTL_MS = 7 * 86_400_000;
export const MAX_TEAM_MEMBERS = 500;

const MANAGERS: TeamRole[] = [TeamRole.OWNER, TeamRole.ADMIN];

const personName = (u: { name: string | null; email: string } | null): string =>
  u?.name?.trim() || u?.email.split('@')[0] || 'Someone';

/**
 * Teams share their owner's token pool (port of the old `teamService`, with
 * every rule enforced server-side). Team projects are visible to all members;
 * see ProjectAccessService for the resulting project roles.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly repository: TeamsRepository,
    private readonly subscriptions: SubscriptionsService,
    private readonly mail: MailService,
  ) {}

  // --- teams -------------------------------------------------------------------

  async create(actor: Actor, dto: CreateTeamDto) {
    const pool = await this.pool(actor.id);
    if (!pool.teamPlan) {
      throw AppError.paymentRequired(
        ErrorCode.TeamPlanRequired,
        'You need a Teams plan to create teams.',
      );
    }
    if (dto.tokenLimit !== undefined) {
      await this.assertLimit(actor.id, dto.tokenLimit, pool.balance);
    }
    const team = await this.repository.createWithOwner({
      name: dto.name,
      ownerId: actor.id,
      tokenLimit: dto.tokenLimit ?? null,
    });
    return this.view(team, TeamRole.OWNER, 1);
  }

  async listMine(actor: Actor) {
    const rows = await this.repository.listForUser(actor.id);
    return rows.map((r) => this.view(r.team, r.role, r.team._count.members));
  }

  async get(actor: Actor, teamId: string) {
    const { team, member } = await this.requireMember(actor.id, teamId);
    const count = await this.repository.countMembers(teamId);
    return this.view(team, member.role, count);
  }

  async update(actor: Actor, teamId: string, dto: UpdateTeamDto) {
    const team = await this.requireOwner(actor.id, teamId);
    if (dto.name === undefined && dto.tokenLimit === undefined) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Nothing to update',
      );
    }
    if (dto.tokenLimit !== undefined && dto.tokenLimit !== null) {
      const pool = await this.pool(actor.id);
      if (!pool.teamPlan) {
        throw AppError.paymentRequired(
          ErrorCode.TeamPlanRequired,
          'You need a Teams plan to change team limits.',
        );
      }
      await this.assertLimit(actor.id, dto.tokenLimit, pool.balance, team.id);
    }
    const updated = await this.repository.updateTeam(teamId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.tokenLimit !== undefined ? { tokenLimit: dto.tokenLimit } : {}),
    });
    const count = await this.repository.countMembers(teamId);
    return this.view(updated, TeamRole.OWNER, count);
  }

  async remove(actor: Actor, teamId: string): Promise<void> {
    await this.requireOwner(actor.id, teamId);
    await this.repository.deleteTeam(teamId);
  }

  // --- members -------------------------------------------------------------------

  async members(actor: Actor, teamId: string) {
    await this.requireMember(actor.id, teamId);
    const members = await this.repository.listMembers(teamId);
    return members.map((m) => ({
      id: m.id,
      user: m.user,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async updateMemberRole(
    actor: Actor,
    teamId: string,
    userId: string,
    role: TeamRole,
  ) {
    const team = await this.requireOwner(actor.id, teamId);
    if (userId === team.ownerId) {
      throw AppError.forbidden(
        ErrorCode.TeamOwnerImmutable,
        'Cannot change the owner role.',
      );
    }
    if (role === TeamRole.OWNER) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Role must be ADMIN or MEMBER',
      );
    }
    const member = await this.repository.findMember(teamId, userId);
    if (!member)
      throw AppError.notFound(
        ErrorCode.MemberNotFound,
        'Team member not found',
      );
    const updated = await this.repository.updateMemberRole(
      teamId,
      userId,
      role,
    );
    return { id: updated.id, role: updated.role };
  }

  async removeMember(
    actor: Actor,
    teamId: string,
    userId: string,
  ): Promise<void> {
    const { team, member: me } = await this.requireMember(actor.id, teamId);
    if (userId === team.ownerId) {
      throw AppError.forbidden(
        ErrorCode.TeamOwnerImmutable,
        'Cannot remove the team owner.',
      );
    }
    if (userId === actor.id) return this.leave(actor, teamId);
    if (!MANAGERS.includes(me.role)) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only team owners or admins can perform this action.',
      );
    }
    const target = await this.repository.findMember(teamId, userId);
    if (!target)
      throw AppError.notFound(
        ErrorCode.MemberNotFound,
        'Team member not found',
      );
    if (me.role === TeamRole.ADMIN && target.role === TeamRole.ADMIN) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Admins cannot remove other admins.',
      );
    }
    await this.repository.removeMember(teamId, userId);
  }

  async leave(actor: Actor, teamId: string): Promise<void> {
    const { team } = await this.requireMember(actor.id, teamId);
    if (team.ownerId === actor.id) {
      throw AppError.forbidden(
        ErrorCode.TeamOwnerImmutable,
        'Team owner cannot leave. Delete the team instead.',
      );
    }
    await this.repository.removeMember(teamId, actor.id);
  }

  // --- invitations -----------------------------------------------------------------

  async invite(actor: Actor, teamId: string, dto: InviteTeamMemberDto) {
    const { team, member: me } = await this.requireManager(actor.id, teamId);
    if (dto.role === TeamRole.ADMIN && me.role !== TeamRole.OWNER) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only the team owner can invite admins.',
      );
    }
    if (dto.email === actor.email.toLowerCase()) {
      throw AppError.conflict(
        ErrorCode.AlreadyTeamMember,
        'You are already in this team.',
      );
    }
    const existingUser = await this.repository.findUserByEmail(dto.email);
    if (
      existingUser &&
      (await this.repository.findMember(teamId, existingUser.id))
    ) {
      throw AppError.conflict(
        ErrorCode.AlreadyTeamMember,
        'User is already a member of this team.',
      );
    }
    const pending = await this.repository.findInvitationByEmail(
      teamId,
      dto.email,
    );
    if (pending && !pending.acceptedAt && pending.expiresAt > new Date()) {
      throw AppError.conflict(
        ErrorCode.InvitationPending,
        'An invitation is already pending for this email.',
      );
    }
    if ((await this.repository.countMembers(teamId)) >= MAX_TEAM_MEMBERS) {
      throw AppError.conflict(
        ErrorCode.ValidationFailed,
        `A team can have at most ${MAX_TEAM_MEMBERS} members.`,
      );
    }

    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await this.repository.upsertInvitation({
      teamId,
      email: dto.email,
      role: dto.role,
      tokenHash: hashOpaqueToken(token),
      invitedById: actor.id,
      expiresAt,
    });
    const inviter = await this.repository.findUser(actor.id);
    this.mail.dispatch(
      () =>
        this.mail.sendTeamInvitation({
          to: dto.email,
          teamName: team.name,
          inviterName: personName(inviter),
          role: dto.role,
          token,
          expiresAt,
        }),
      'team-invitation',
    );
    return this.invitationView(invitation);
  }

  async invitations(actor: Actor, teamId: string) {
    await this.requireManager(actor.id, teamId);
    const rows = await this.repository.listPendingInvitations(teamId);
    return rows.map((i) => this.invitationView(i));
  }

  async cancelInvitation(
    actor: Actor,
    teamId: string,
    invitationId: string,
  ): Promise<void> {
    await this.requireManager(actor.id, teamId);
    const invitation = await this.repository.findInvitation(
      teamId,
      invitationId,
    );
    if (!invitation || invitation.acceptedAt) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invitation not found or expired.',
      );
    }
    await this.repository.deleteInvitation(invitationId);
  }

  /** Pending invitations addressed to the caller's email. */
  async myInvitations(actor: Actor) {
    const rows = await this.repository.listPendingForEmail(
      actor.email.toLowerCase(),
    );
    return rows.map((i) => ({
      id: i.id,
      team: i.team,
      role: i.role,
      invitedBy: i.invitedBy
        ? { name: i.invitedBy.name, email: i.invitedBy.email }
        : null,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    }));
  }

  async previewInvitation(token: string) {
    const invitation = await this.loadInvitation(token);
    this.assertOpen(invitation);
    return {
      teamId: invitation.team.id,
      teamName: invitation.team.name,
      email: invitation.email,
      role: invitation.role,
      inviterName: personName(invitation.invitedBy),
      expiresAt: invitation.expiresAt,
    };
  }

  async acceptInvitation(actor: Actor, token: string) {
    const invitation = await this.loadInvitation(token);
    this.assertOpen(invitation);
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
    const teamId = invitation.team.id;
    await this.repository.transaction(async (tx) => {
      if (await this.repository.findMember(teamId, actor.id, tx)) {
        throw AppError.conflict(
          ErrorCode.AlreadyTeamMember,
          'You are already a member of this team.',
        );
      }
      if (!(await this.repository.markInvitationAccepted(invitation.id, tx))) {
        throw AppError.conflict(
          ErrorCode.InvitationAlreadyAccepted,
          'This invitation has already been used',
        );
      }
      try {
        await this.repository.addMember(teamId, actor.id, invitation.role, tx);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw AppError.conflict(
            ErrorCode.AlreadyTeamMember,
            'You are already a member of this team.',
          );
        }
        throw error;
      }
    });
    return {
      teamId,
      teamName: invitation.team.name,
      role: invitation.role,
      message: `You have joined ${invitation.team.name}.`,
    };
  }

  // --- tokens ----------------------------------------------------------------------

  async tokenSummary(actor: Actor, teamId: string) {
    const { team } = await this.requireMember(actor.id, teamId);
    const pool = await this.pool(team.ownerId);
    const poolUsed = await this.repository.sumUsedByOwner(team.ownerId);
    return {
      teamId: team.id,
      teamName: team.name,
      tokenLimit: team.tokenLimit,
      tokensUsed: team.tokensUsed,
      tokensRemaining:
        team.tokenLimit === null
          ? null
          : Math.max(0, team.tokenLimit - team.tokensUsed),
      poolTotal: pool.allocation,
      poolUsed,
      poolRemaining: pool.balance,
      ownerPlanActive: pool.teamPlan,
    };
  }

  async usageByMember(actor: Actor, teamId: string, query: TeamUsageQueryDto) {
    await this.requireManager(actor.id, teamId);
    const [members, usage] = await Promise.all([
      this.repository.listMembers(teamId),
      this.repository.usageByMember(teamId, query.from, query.to),
    ]);
    const byUser = new Map(usage.map((u) => [u.userId, u._sum.tokens ?? 0]));
    return members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      tokensUsed: byUser.get(m.user.id) ?? 0,
    }));
  }

  // --- helpers -----------------------------------------------------------------------

  private async pool(ownerId: string) {
    const overview = await this.subscriptions.overview(ownerId);
    const sub = overview.subscription;
    const live =
      sub &&
      (sub.status === SubscriptionStatus.ACTIVE ||
        sub.status === SubscriptionStatus.PAST_DUE);
    return {
      teamPlan: Boolean(live && TEAM_TIERS.includes(sub.plan.tier)),
      balance: overview.balance,
      allocation: sub?.tokenAllocation ?? 0,
    };
  }

  /** The new cap plus every other team cap must fit in the owner's balance. */
  private async assertLimit(
    ownerId: string,
    limit: number,
    balance: number,
    excludeTeamId?: string,
  ): Promise<void> {
    const allocated = await this.repository.sumLimits(ownerId, excludeTeamId);
    const available = Math.max(0, balance - allocated);
    if (limit > available) {
      throw AppError.badRequest(
        ErrorCode.TeamTokenLimitInvalid,
        `Token limit exceeds available pool. Available: ${available.toLocaleString('en-US')}`,
      );
    }
  }

  private async requireMember(userId: string, teamId: string) {
    const team = await this.repository.findTeam(teamId);
    const member = team
      ? await this.repository.findMember(teamId, userId)
      : null;
    if (!team || !member)
      throw AppError.notFound(ErrorCode.TeamNotFound, 'Team not found.');
    return { team, member };
  }

  private async requireManager(userId: string, teamId: string) {
    const result = await this.requireMember(userId, teamId);
    if (!MANAGERS.includes(result.member.role)) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only team owners or admins can perform this action.',
      );
    }
    return result;
  }

  private async requireOwner(userId: string, teamId: string): Promise<Team> {
    const { team } = await this.requireMember(userId, teamId);
    if (team.ownerId !== userId) {
      throw AppError.forbidden(
        ErrorCode.Forbidden,
        'Only team owners can perform this action.',
      );
    }
    return team;
  }

  private async loadInvitation(token: string) {
    if (!OPAQUE_TOKEN_PATTERN.test(token)) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invitation not found or expired.',
      );
    }
    const invitation = await this.repository.findInvitationByHash(
      hashOpaqueToken(token),
    );
    if (!invitation) {
      throw AppError.notFound(
        ErrorCode.InvitationNotFound,
        'Invitation not found or expired.',
      );
    }
    return invitation;
  }

  private assertOpen(invitation: {
    acceptedAt: Date | null;
    expiresAt: Date;
  }): void {
    if (invitation.acceptedAt) {
      throw AppError.conflict(
        ErrorCode.InvitationAlreadyAccepted,
        'This invitation has already been used',
      );
    }
    if (invitation.expiresAt <= new Date()) {
      throw AppError.badRequest(
        ErrorCode.InvitationExpired,
        'This invitation has expired.',
      );
    }
  }

  private view(team: Team, role: TeamRole, memberCount: number) {
    return {
      id: team.id,
      name: team.name,
      ownerId: team.ownerId,
      tokenLimit: team.tokenLimit,
      tokensUsed: team.tokensUsed,
      role,
      memberCount,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  }

  private invitationView(i: {
    id: string;
    email: string;
    role: TeamRole;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      sentAt: i.updatedAt,
    };
  }
}
