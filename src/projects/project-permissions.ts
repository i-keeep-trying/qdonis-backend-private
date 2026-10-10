import { ProjectRole, TeamRole } from '../generated/prisma/enums';

/** The owner is not a stored role: it is `Project.ownerId`. */
export type EffectiveRole = 'OWNER' | ProjectRole;

export type AccessVia =
  'ownership' | 'direct_share' | 'link_share' | 'team' | 'platform_admin';

export interface ProjectPermissions {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canManageVersions: boolean;
  canExport: boolean;
  canComment: boolean;
}

export type Permission = keyof ProjectPermissions;

/** Same matrix as the old frontend (`types/sharingTypes.ts`). */
export const ROLE_PERMISSIONS: Record<EffectiveRole, ProjectPermissions> = {
  VIEWER: {
    canView: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
    canManageVersions: false,
    canExport: true,
    canComment: true,
  },
  EDITOR: {
    canView: true,
    canEdit: true,
    canShare: false,
    canDelete: false,
    canManageVersions: true,
    canExport: true,
    canComment: true,
  },
  ADMIN: {
    canView: true,
    canEdit: true,
    canShare: true,
    canDelete: false,
    canManageVersions: true,
    canExport: true,
    canComment: true,
  },
  OWNER: {
    canView: true,
    canEdit: true,
    canShare: true,
    canDelete: true,
    canManageVersions: true,
    canExport: true,
    canComment: true,
  },
};

const RANK: Record<EffectiveRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
  OWNER: 4,
};

export const higherRole = (
  a: EffectiveRole,
  b: EffectiveRole,
): EffectiveRole => (RANK[a] >= RANK[b] ? a : b);

/** Team owners/admins administer team projects; members edit them. */
export const TEAM_ROLE_TO_PROJECT: Record<TeamRole, ProjectRole> = {
  [TeamRole.OWNER]: ProjectRole.ADMIN,
  [TeamRole.ADMIN]: ProjectRole.ADMIN,
  [TeamRole.MEMBER]: ProjectRole.EDITOR,
};

export interface ProjectAccess {
  projectId: string;
  projectName: string;
  ownerId: string;
  teamId: string | null;
  role: EffectiveRole;
  permissions: ProjectPermissions;
  via: AccessVia;
  isOwner: boolean;
}
