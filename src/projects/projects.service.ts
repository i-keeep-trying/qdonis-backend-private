import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import type { Prisma } from '../generated/prisma/client';
import { ProjectActivityType } from '../generated/prisma/enums';
import { StoredFilesService } from '../storage/stored-files.service';
import {
  type CreateProjectDto,
  type CreateVersionDto,
  DEFAULT_PROJECT_NAME,
  type DuplicateProjectDto,
  type ListProjectsQueryDto,
  type AdminProjectsQueryDto,
  type SaveStudioDto,
  type UpdateProjectDto,
} from './dto/project.dto';
import {
  ProjectDetailEntity,
  ProjectSummaryEntity,
  ProjectVersionEntity,
  SaveResultEntity,
} from './entities/project.entity';
import { ProjectAccessService } from './project-access.service';
import { describeActivity } from './project-activity';
import type { ProjectAccess } from './project-permissions';
import {
  legacyProgress,
  type Progress,
  studioProgress,
} from './project-progress';
import { byteSize, MAX_PROJECT_DATA_BYTES } from './project-limits';
import { ProjectsRepository, type ProjectMeta } from './projects.repository';
import {
  createEmptyProject,
  type JsonObject,
  type StudioProject,
} from './studio/studio-graph';
import {
  revisionConflict,
  StudioGraphService,
} from './studio/studio-graph.service';
import {
  heavyBlobName,
  heavyOf,
  isGraphInTables,
  loadStudioProject,
  parseStudioProject,
  projectDataFor,
  toProjectData,
} from './studio/studio-persistence';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function stripStudio(data: JsonObject): JsonObject {
  const base = { ...data };
  delete base.studio;
  return base;
}

/**
 * Progress derived from `projects.data`, or null when the Studio graph lives
 * in tables (its writes keep progress up to date, so it is left as stored).
 */
function progressOf(data: JsonObject): Progress | null {
  if (isGraphInTables(data)) return null;
  return isObject(data.studio)
    ? studioProgress(loadStudioProject(data))
    : legacyProgress(data);
}

const progressColumns = (progress: Progress | null) =>
  progress
    ? { progressCompleted: progress.completed, progressTotal: progress.total }
    : {};

export interface ProjectCreatedEvent {
  projectId: string;
  actorId: string;
  prompt: string | null;
}
export type ProjectCreatedListener = (event: ProjectCreatedEvent) => void;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly createdListeners: ProjectCreatedListener[] = [];

  constructor(
    private readonly repository: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly files: StoredFilesService,
    private readonly graph: StudioGraphService,
  ) {}

  // --- create / read -----------------------------------------------------------

  async create(
    user: Actor,
    dto: CreateProjectDto,
  ): Promise<ProjectDetailEntity> {
    if (
      dto.teamId &&
      !(await this.repository.isTeamMember(dto.teamId, user.id))
    ) {
      throw AppError.notFound(ErrorCode.TeamNotFound, 'Team not found');
    }
    const studio = createEmptyProject(dto.prompt);
    const data = projectDataFor(studio, null);
    this.assertSize(data);
    const progress = studioProgress(studio);

    const meta = await this.repository.transaction(async (tx) => {
      const created = await this.repository.create(
        {
          ownerId: user.id,
          teamId: dto.teamId ?? null,
          name: dto.name ?? DEFAULT_PROJECT_NAME,
          // A prompt without a name gets one generated (DesignService); clients show it loading.
          namingStartedAt: dto.prompt?.trim() && !dto.name ? new Date() : null,
          description: dto.description || null,
          data: data as Prisma.InputJsonObject,
          dataBytes: byteSize(data),
          progressCompleted: progress.completed,
          progressTotal: progress.total,
        },
        tx,
      );
      await this.graph.initialise(created.id, user.id, studio, tx);
      await this.repository.logActivity(
        {
          projectId: created.id,
          userId: user.id,
          type: ProjectActivityType.CREATE,
        },
        tx,
      );
      return created;
    });
    this.notifyCreated({
      projectId: meta.id,
      actorId: user.id,
      prompt: dto.prompt ?? null,
    });
    return this.detail(user, meta.id);
  }

  async list(
    user: Actor,
    query: ListProjectsQueryDto,
  ): Promise<PaginatedResultDto<ProjectSummaryEntity>> {
    const { items, total } = await this.repository.page({
      userId: user.id,
      scope: query.scope,
      teamId: query.teamId,
      search: query.search,
      skip: query.skip,
      take: query.take,
    });
    const rows = items.map((row) => {
      if (row.ownerId === user.id)
        return new ProjectSummaryEntity(row, 'OWNER');
      // Team membership only grants EDITOR/ADMIN; a direct share may be higher.
      return new ProjectSummaryEntity(row, row.memberRole ?? 'EDITOR');
    });
    return new PaginatedResultDto(rows, total, query.skip, query.take);
  }

  async adminList(
    query: AdminProjectsQueryDto,
  ): Promise<PaginatedResultDto<ProjectSummaryEntity>> {
    const { items, total } = await this.repository.pageAll({
      search: query.search,
      ownerId: query.ownerId,
      skip: query.skip,
      take: query.take,
    });
    return new PaginatedResultDto(
      items.map((row) => new ProjectSummaryEntity(row, 'VIEWER')),
      total,
      query.skip,
      query.take,
    );
  }

  /** Full project with data and the Studio graph; refreshes last-accessed. */
  async detail(user: Actor, projectId: string): Promise<ProjectDetailEntity> {
    const access = await this.access.require(user, projectId);
    // First: moves an old project's graph into tables (rewrites `data`).
    const studio = await this.graph.load(projectId, user.id);
    const [row, full] = await Promise.all([
      this.repository.findListRow(projectId),
      this.repository.findWithData(projectId),
    ]);
    if (!row || !full) {
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    }
    const data = isObject(full.data) ? full.data : {};
    if (access.via !== 'platform_admin') {
      this.repository
        .touch(projectId, user.id)
        .catch((error: unknown) =>
          this.logger.warn(
            `Could not update last access of ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    return new ProjectDetailEntity(row, access, data, studio);
  }

  accessOf(user: Actor, projectId: string): Promise<ProjectAccess> {
    return this.access.require(user, projectId);
  }

  // --- update ------------------------------------------------------------------

  async update(
    user: Actor,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectSummaryEntity> {
    const access = await this.access.require(user, projectId, 'canEdit');
    if (dto.name === undefined && dto.description === undefined) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Nothing to update',
      );
    }
    const before = await this.repository.findMeta(projectId);
    if (!before)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');

    await this.repository.updateMeta(projectId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description || null }
        : {}),
    });
    if (dto.name !== undefined && dto.name !== before.name) {
      await this.repository.logActivity({
        projectId,
        userId: user.id,
        type: ProjectActivityType.RENAME,
        details: { old_name: before.name, new_name: dto.name },
      });
    }
    const row = await this.repository.findListRow(projectId);
    return new ProjectSummaryEntity(row!, access.role);
  }

  /**
   * Saves the Studio graph (server half of the old StudioShell autosave):
   * heavy simulation payloads are written to S3 (only when changed), the graph
   * is normalised, the legacy summary keys are derived, progress is
   * recomputed, and the write is a compare-and-swap on `revision`.
   */
  async saveStudio(
    user: Actor,
    projectId: string,
    dto: SaveStudioDto,
  ): Promise<SaveResultEntity> {
    await this.access.require(user, projectId, 'canEdit');
    const studio = parseStudioProject(dto.studio);

    const current = await this.repository.findMeta(projectId);
    if (!current)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    // Cheap early check so a stale client does not upload blobs for nothing.
    if (current.revision !== dto.revision)
      throw revisionConflict(current.revision);

    const storedBlobs = await this.storeHeavyPayloads(
      projectId,
      user.id,
      studio,
    );
    // The graph as sent replaces the stored one; the revision check under
    // the row lock guarantees nobody else's change is overwritten.
    const { meta } = await this.graph.mutate(projectId, user.id, () => studio, {
      expectedRevision: dto.revision,
    });
    return new SaveResultEntity(meta, storedBlobs);
  }

  /** Moves changed heavy simulation payloads to S3 blobs `studio/<nodeId>`. */
  private async storeHeavyPayloads(
    projectId: string,
    actorId: string,
    studio: StudioProject,
  ): Promise<number> {
    let stored = 0;
    for (const node of Object.values(studio.nodes)) {
      if (node.status !== 'ready') continue;
      const heavy = heavyOf(node);
      if (!heavy) continue;
      const name = heavyBlobName(node.id);
      const body = JSON.stringify(heavy);
      const existing = await this.files.findStageBlob(projectId, name);
      if (existing?.sha256 === sha256(body)) continue;
      await this.files.putStageBlob({ projectId, actorId, name, value: heavy });
      stored += 1;
    }
    return stored;
  }

  // --- delete / duplicate --------------------------------------------------------

  /**
   * Owner: deletes the project (its S3 objects are queued for deletion).
   * Direct collaborator: leaves the project (old behaviour of "delete" on a
   * shared project). Team-only access cannot be dropped here.
   */
  async remove(
    user: Actor,
    projectId: string,
  ): Promise<{ deleted: boolean; left: boolean }> {
    const access = await this.access.require(user, projectId);
    if (access.isOwner) {
      await this.repository.delete(projectId);
      return { deleted: true, left: false };
    }
    if (access.via === 'direct_share' || access.via === 'link_share') {
      await this.repository.removeMember(projectId, user.id);
      await this.repository.logActivity({
        projectId,
        userId: user.id,
        type: ProjectActivityType.ACCESS_REVOKED,
        details: { via: 'left_project' },
      });
      return { deleted: false, left: true };
    }
    throw AppError.forbidden(
      ErrorCode.Forbidden,
      'Only the owner can delete this project',
    );
  }

  /**
   * Personal copy for the caller with every stored file copied. All or
   * nothing: if a file copy fails the new project is deleted again.
   */
  async duplicate(
    user: Actor,
    projectId: string,
    dto: DuplicateProjectDto,
  ): Promise<ProjectDetailEntity> {
    await this.access.require(user, projectId);
    // An old project is moved into tables first, so its graph can be copied.
    await this.graph.ensureImported(projectId);

    const copy = await this.repository.transaction(async (tx) => {
      // Locked: data and graph are copied from the same revision.
      const locked = await this.repository.lockData(projectId, tx);
      const source = await this.repository.findWithData(projectId, tx);
      if (!locked || !source)
        throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
      const name =
        dto.name ?? `${source.name || 'Untitled Project'} - copy`.slice(0, 200);
      const data = isObject(source.data) ? source.data : {};
      const created = await this.repository.create(
        {
          ownerId: user.id,
          teamId: null,
          name,
          description: source.description,
          data: data,
          dataBytes: source.dataBytes,
          progressCompleted: source.progressCompleted,
          progressTotal: source.progressTotal,
        },
        tx,
      );
      await this.repository.logActivity(
        {
          projectId: created.id,
          userId: user.id,
          type: ProjectActivityType.DUPLICATE,
          details: { source_project_id: projectId },
        },
        tx,
      );
      // Same node and branch ids: S3 blobs `studio/<nodeId>` keep matching.
      await this.graph.copyInto(projectId, created.id, user.id, tx);
      return { id: created.id, data };
    });

    try {
      const idMap = await this.files.copyProjectFiles(
        projectId,
        copy.id,
        user.id,
      );
      if (idMap.size > 0) {
        // File ids referenced inside the data must point at the copies.
        let json = JSON.stringify(copy.data);
        for (const [from, to] of idMap) json = json.split(from).join(to);
        const rewritten = JSON.parse(json) as JsonObject;
        await this.repository.saveData(copy.id, null, {
          data: rewritten as Prisma.InputJsonObject,
          dataBytes: byteSize(rewritten),
        });
        await this.graph.rewriteNodeData(copy.id, idMap);
      }
    } catch (error) {
      await this.repository
        .delete(copy.id)
        .catch((cleanup: unknown) =>
          this.logger.error(
            `Could not remove incomplete duplicate ${copy.id}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
          ),
        );
      throw error;
    }
    return this.detail(user, copy.id);
  }

  // --- versions ---------------------------------------------------------------

  async createVersion(
    user: Actor,
    projectId: string,
    dto: CreateVersionDto,
  ): Promise<ProjectVersionEntity> {
    await this.access.require(user, projectId, 'canManageVersions');
    // A version is self-contained: the whole graph is embedded (version 1
    // form), so it can be restored even after branches were deleted.
    const studio = await this.graph.snapshot(projectId, user.id);
    const current = await this.repository.findWithData(projectId);
    if (!current)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    const data = toProjectData(
      studio,
      stripStudio(isObject(current.data) ? current.data : {}),
    );
    const version = await this.repository.createVersion({
      projectId,
      revision: current.revision,
      data: data as Prisma.InputJsonObject,
      description: dto.description || null,
      createdById: user.id,
    });
    return new ProjectVersionEntity(version);
  }

  async listVersions(
    user: Actor,
    projectId: string,
  ): Promise<ProjectVersionEntity[]> {
    await this.access.require(user, projectId);
    const versions = await this.repository.listVersions(projectId);
    return versions.map((v) => new ProjectVersionEntity(v));
  }

  async restoreVersion(
    user: Actor,
    projectId: string,
    versionId: string,
  ): Promise<SaveResultEntity> {
    await this.access.require(user, projectId, 'canManageVersions');
    await this.access.require(user, projectId, 'canEdit');
    const version = await this.repository.findVersion(projectId, versionId);
    if (!version)
      throw AppError.notFound(ErrorCode.VersionNotFound, 'Version not found');
    const data = isObject(version.data) ? version.data : {};
    if (isGraphInTables(data)) {
      // Holds no results; restoring it would wipe every branch.
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'This version has no saved Studio results and cannot be restored',
      );
    }
    // Old versions hold a version-1 graph or wizard data; both convert.
    const restored = loadStudioProject(data);
    const { meta } = await this.graph.mutate(
      projectId,
      user.id,
      () => restored,
      { baseData: stripStudio(data) },
    );
    await this.repository.logActivity({
      projectId,
      userId: user.id,
      type: ProjectActivityType.EDIT,
      details: { step_name: 'version restore', version_id: versionId },
    });
    return new SaveResultEntity(meta, 0);
  }

  // --- activity ---------------------------------------------------------------

  async activity(
    user: Actor,
    projectId: string,
    query: {
      types?: ProjectActivityType[];
      userId?: string;
      skip: number;
      take: number;
    },
  ) {
    await this.access.require(user, projectId);
    const { items, total } = await this.repository.pageActivity({
      projectId,
      types: query.types,
      userId: query.userId,
      skip: query.skip,
      take: query.take,
    });
    const rows = items.map((a) => {
      const details = isObject(a.details) ? a.details : {};
      return {
        id: a.id,
        type: a.type,
        action: describeActivity(a.type, details),
        details,
        stage: a.stage,
        user: a.user
          ? {
              id: a.user.id,
              name: a.user.name,
              email: a.user.email,
              avatarUrl: a.user.avatarUrl,
            }
          : null,
        createdAt: a.createdAt,
      };
    });
    return new PaginatedResultDto(rows, total, query.skip, query.take);
  }

  // --- server-side writes (design steps) ---------------------------------------

  /**
   * Read-modify-write of `projects.data` under a row lock, for results
   * computed on the server. Bumps the revision, so a client holding an older
   * revision gets 409 on its next save and reloads. `mutate` must be
   * synchronous and cheap: it runs inside the transaction.
   */
  async mutateData(
    projectId: string,
    mutate: (data: JsonObject) => JsonObject,
  ): Promise<ProjectMeta> {
    return this.repository.transaction(async (tx) => {
      const row = await this.repository.lockData(projectId, tx);
      if (!row)
        throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
      const next = mutate(isObject(row.data) ? row.data : {});
      const dataBytes = this.assertSize(next);
      const saved = await this.repository.saveData(
        projectId,
        row.revision,
        {
          data: next as Prisma.InputJsonObject,
          dataBytes,
          ...progressColumns(progressOf(next)),
        },
        tx,
      );
      if (!saved) throw revisionConflict(row.revision);
      return saved;
    });
  }

  /**
   * Applies a change to the Studio graph on the server, atomically with any
   * other writer. `userId` is whose branch the change starts on (null: the
   * first branch) and whose cursor follows a fork; `branchId` overrides it.
   */
  async mutateStudio(
    projectId: string,
    userId: string | null,
    mutate: (studio: StudioProject) => StudioProject,
    branchId?: string,
  ): Promise<ProjectMeta> {
    const { meta } = await this.graph.mutate(projectId, userId, mutate, {
      branchId,
    });
    return meta;
  }

  /** The Studio graph on the caller's branch (or `branchId`). */
  loadStudio(
    projectId: string,
    userId: string,
    branchId?: string,
  ): Promise<StudioProject> {
    return this.graph.load(projectId, userId, branchId);
  }

  /** Sets a generated name unless the project was renamed meanwhile. */
  renameIfDefault(projectId: string, name: string): Promise<boolean> {
    return this.repository.renameIf(projectId, DEFAULT_PROJECT_NAME, name);
  }

  /** The generated-name call ended; the project keeps whatever name it has. */
  endNaming(projectId: string): Promise<void> {
    return this.repository.endNaming(projectId);
  }

  /** Called after every successful create (e.g. to generate a name). */
  onProjectCreated(listener: ProjectCreatedListener): void {
    this.createdListeners.push(listener);
  }

  private notifyCreated(event: ProjectCreatedEvent): void {
    for (const listener of this.createdListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `Project-created listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // --- helpers ------------------------------------------------------------------

  private assertSize(data: JsonObject): number {
    const bytes = byteSize(data);
    if (bytes > MAX_PROJECT_DATA_BYTES) {
      throw AppError.tooLarge(
        ErrorCode.ProjectDataTooLarge,
        `Project data is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_PROJECT_DATA_BYTES / 1024 / 1024} MB. Large results must be stored as files.`,
      );
    }
    return bytes;
  }
}

export type { ProjectMeta };
