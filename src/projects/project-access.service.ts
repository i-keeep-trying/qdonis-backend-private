import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { ProjectRole, Role } from '../generated/prisma/enums';
import {
  type AccessVia,
  type EffectiveRole,
  higherRole,
  type Permission,
  type ProjectAccess,
  ROLE_PERMISSIONS,
  TEAM_ROLE_TO_PROJECT,
} from './project-permissions';
import { ProjectsRepository } from './projects.repository';

const PERMISSION_MESSAGES: Record<Permission, string> = {
  canView: 'You do not have access to this project',
  canEdit:
    'You have view-only access to this project. Contact the owner for edit permissions.',
  canShare: 'Only the owner or a project admin can share this project',
  canDelete: 'Only the owner can delete this project',
  canManageVersions: 'You cannot manage versions of this project',
  canExport: 'You cannot export this project',
  canComment: 'You cannot comment on this project',
};

/**
 * The single authorisation point for projects (replaces the Supabase RLS
 * policies and `get_user_project_role`). Every project route resolves access
 * here before touching data.
 *
 * Order: owner -> direct share (not expired) / team membership (highest wins)
 * -> platform administrator (read-only). A project the caller cannot see is
 * reported as 404 so ids cannot be probed.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly repository: ProjectsRepository) {}

  async resolve(
    user: Pick<AuthenticatedUser, 'id' | 'role'>,
    projectId: string,
  ): Promise<ProjectAccess | null> {
    const ctx = await this.repository.accessContext(projectId, user.id);
    if (!ctx) return null;

    const build = (role: EffectiveRole, via: AccessVia): ProjectAccess => ({
      projectId: ctx.id,
      projectName: ctx.name,
      ownerId: ctx.ownerId,
      teamId: ctx.teamId,
      role,
      permissions: ROLE_PERMISSIONS[role],
      via,
      isOwner: role === 'OWNER',
    });

    if (ctx.ownerId === user.id) return build('OWNER', 'ownership');

    const memberActive =
      ctx.member &&
      (!ctx.member.expiresAt || ctx.member.expiresAt > new Date());
    const memberRole: EffectiveRole | null = memberActive
      ? ctx.member!.role
      : null;
    const teamRole: EffectiveRole | null = ctx.teamRole
      ? TEAM_ROLE_TO_PROJECT[ctx.teamRole]
      : null;

    if (memberRole || teamRole) {
      const role =
        memberRole && teamRole
          ? higherRole(memberRole, teamRole)
          : (memberRole ?? teamRole)!;
      const via: AccessVia =
        memberRole === role
          ? ctx.member!.shareLinkId
            ? 'link_share'
            : 'direct_share'
          : 'team';
      return build(role, via);
    }

    if (user.role === Role.ADMIN) {
      return build(ProjectRole.VIEWER, 'platform_admin');
    }
    return null;
  }

  /** Resolves access and requires `permission`; 404 without any access. */
  async require(
    user: Pick<AuthenticatedUser, 'id' | 'role'>,
    projectId: string,
    permission: Permission = 'canView',
  ): Promise<ProjectAccess> {
    const access = await this.resolve(user, projectId);
    if (!access) {
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    }
    if (!access.permissions[permission]) {
      throw AppError.forbidden(
        permission === 'canEdit'
          ? ErrorCode.ProjectReadOnly
          : ErrorCode.Forbidden,
        PERMISSION_MESSAGES[permission],
      );
    }
    return access;
  }
}
