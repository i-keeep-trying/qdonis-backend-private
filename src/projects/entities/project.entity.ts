import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { ProjectVersion } from '../../generated/prisma/client';
import type {
  AccessVia,
  EffectiveRole,
  ProjectAccess,
  ProjectPermissions,
} from '../project-permissions';
import type { ProjectListRow, ProjectMeta } from '../projects.repository';
import type { StudioProject } from '../studio/studio-graph';

/** The name call is aborted after 120 s; a little slack on top. */
const NAMING_TIMEOUT_MS = 150_000;

export class PersonRefEntity {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ type: String, nullable: true }) name: string | null;
  @ApiProperty() email: string;

  constructor(person: { id: string; name: string | null; email: string }) {
    this.id = person.id;
    this.name = person.name;
    this.email = person.email;
  }
}

export class ProjectAccessEntity {
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] })
  role: EffectiveRole;
  @ApiProperty() isOwner: boolean;
  @ApiProperty({
    enum: ['ownership', 'direct_share', 'link_share', 'team', 'platform_admin'],
  })
  via: AccessVia;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'boolean' } })
  permissions: ProjectPermissions;

  constructor(access: ProjectAccess) {
    this.role = access.role;
    this.isOwner = access.isOwner;
    this.via = access.via;
    this.permissions = access.permissions;
  }
}

export class ProjectSummaryEntity {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({
    description:
      'True while the name is being generated from the creation prompt (show it as loading)',
  })
  naming: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) description:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teamId: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true })
  team: { id: string; name: string } | null;
  @ApiProperty({ type: PersonRefEntity }) owner: PersonRefEntity;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] })
  role: EffectiveRole;
  @ApiProperty() completedSteps: number;
  @ApiProperty() totalSteps: number;
  @ApiProperty() revision: number;
  @ApiProperty() lastAccessedAt: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;

  constructor(row: ProjectListRow, role: EffectiveRole) {
    this.id = row.id;
    this.name = row.name;
    // A call that never ended (server restart) stops counting after its timeout.
    this.naming =
      row.namingStartedAt !== null &&
      Date.now() - row.namingStartedAt.getTime() < NAMING_TIMEOUT_MS;
    this.description = row.description;
    this.teamId = row.teamId;
    this.team = row.team;
    this.owner = new PersonRefEntity(row.owner);
    this.role = role;
    this.completedSteps = row.progressCompleted;
    this.totalSteps = row.progressTotal;
    this.revision = row.revision;
    this.lastAccessedAt = row.lastAccessedAt;
    this.createdAt = row.createdAt;
    this.updatedAt = row.updatedAt;
  }
}

export class ProjectDetailEntity extends ProjectSummaryEntity {
  @ApiProperty({ type: ProjectAccessEntity }) access: ProjectAccessEntity;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Stored project data (legacy summary keys + `studio`)',
  })
  data: Record<string, unknown>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The Studio graph (legacy projects converted on read)',
  })
  studio: StudioProject;

  constructor(
    row: ProjectListRow,
    access: ProjectAccess,
    data: Record<string, unknown>,
    studio: StudioProject,
  ) {
    super(row, access.role);
    this.access = new ProjectAccessEntity(access);
    this.data = data;
    this.studio = studio;
  }
}

export class SaveResultEntity {
  @ApiProperty() revision: number;
  @ApiProperty() completedSteps: number;
  @ApiProperty() totalSteps: number;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ description: 'Heavy payloads moved to storage in this save' })
  storedBlobs: number;

  constructor(meta: ProjectMeta, storedBlobs: number) {
    this.revision = meta.revision;
    this.completedSteps = meta.progressCompleted;
    this.totalSteps = meta.progressTotal;
    this.updatedAt = meta.updatedAt;
    this.storedBlobs = storedBlobs;
  }
}

export class ProjectVersionEntity {
  @ApiProperty() id: string;
  @ApiProperty() revision: number;
  @ApiPropertyOptional({ type: String, nullable: true }) description:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) createdById:
    string | null;
  @ApiProperty() createdAt: Date;

  constructor(version: Omit<ProjectVersion, 'data'>) {
    this.id = version.id;
    this.revision = version.revision;
    this.description = version.description;
    this.createdById = version.createdById;
    this.createdAt = version.createdAt;
  }
}
