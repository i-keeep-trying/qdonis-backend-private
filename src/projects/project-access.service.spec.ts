import { ProjectRole, Role, TeamRole } from '../generated/prisma/enums';
import { ProjectAccessService } from './project-access.service';
import type { AccessContext, ProjectsRepository } from './projects.repository';

const base: AccessContext = {
  id: 'p1',
  name: 'P',
  ownerId: 'owner',
  teamId: null,
  member: null,
  teamRole: null,
};

function service(ctx: AccessContext | null) {
  const repo = { accessContext: jest.fn().mockResolvedValue(ctx) };
  return new ProjectAccessService(repo as unknown as ProjectsRepository);
}

const user = (id: string, role: Role = Role.USER) => ({ id, role });

describe('ProjectAccessService', () => {
  it('owner has every permission', async () => {
    const access = await service(base).resolve(user('owner'), 'p1');
    expect(access).toMatchObject({
      role: 'OWNER',
      via: 'ownership',
      isOwner: true,
    });
    expect(Object.values(access!.permissions).every(Boolean)).toBe(true);
  });

  it('ignores expired shares and picks the higher of share and team roles', async () => {
    const expired = {
      ...base,
      member: {
        id: 'm',
        role: ProjectRole.ADMIN,
        expiresAt: new Date(0),
        shareLinkId: null,
      },
    };
    await expect(service(expired).resolve(user('u'), 'p1')).resolves.toBeNull();

    const both = {
      ...base,
      teamId: 't',
      teamRole: TeamRole.MEMBER,
      member: {
        id: 'm',
        role: ProjectRole.VIEWER,
        expiresAt: null,
        shareLinkId: 'l',
      },
    };
    await expect(service(both).resolve(user('u'), 'p1')).resolves.toMatchObject(
      {
        role: 'EDITOR',
        via: 'team',
      },
    );

    const viaLink = { ...both, teamRole: null };
    await expect(
      service(viaLink).resolve(user('u'), 'p1'),
    ).resolves.toMatchObject({
      role: 'VIEWER',
      via: 'link_share',
    });
  });

  it('platform admins are read-only; strangers get 404; viewers cannot edit', async () => {
    await expect(
      service(base).resolve(user('a', Role.ADMIN), 'p1'),
    ).resolves.toMatchObject({
      role: 'VIEWER',
      via: 'platform_admin',
    });
    await expect(service(base).require(user('x'), 'p1')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service(null).require(user('owner'), 'p1'),
    ).rejects.toMatchObject({
      status: 404,
    });
    const viewer = {
      ...base,
      member: {
        id: 'm',
        role: ProjectRole.VIEWER,
        expiresAt: null,
        shareLinkId: null,
      },
    };
    await expect(
      service(viewer).require(user('v'), 'p1', 'canEdit'),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});
