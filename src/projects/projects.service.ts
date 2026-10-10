import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

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
import { ProjectsRepository, type ProjectMeta } from './projects.repository';
import {
  createEmptyProject,
  type JsonObject,
  type StudioProject,
} from './studio/studio-graph';
import {
  heavyBlobName,
  heavyOf,
  loadStudioProject,
  parseStudioProject,
  toProjectData,
} from './studio/studio-persistence';

/** Stored `projects.data` cap. Heavy payloads go to S3 instead. */
export const MAX_PROJECT_DATA_BYTES = 4 * 1024 * 1024;

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const byteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

function progressOf(data: JsonObject): Progress {
  return isObject(data.studio)
    ? studioProgress(loadStudioProject(data))
    : legacyProgress(data);
}

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
    const data = toProjectData(studio, null);
    this.assertSize(data);
    const progress = studioProgress(studio);

    const meta = await this.repository.transaction(async (tx) => {
      const created = await this.repository.create(
        {
          ownerId: user.id,
          teamId: dto.teamId ?? null,
          name: dto.name ?? DEFAULT_PROJECT_NAME,
          description: dto.description || null,
          data: data as Prisma.InputJsonObject,
          dataBytes: byteSize(data),
          progressCompleted: progress.completed,
          progressTotal: progress.total,
        },
        tx,
      );
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
    return new ProjectDetailEntity(row, access, data, loadStudioProject(data));
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

    const current = await this.repository.findWithData(projectId);
    if (!current)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    if (current.revision !== dto.revision) this.conflict(current.revision);

    const storedBlobs = await this.storeHeavyPayloads(
      projectId,
      user.id,
      studio,
    );

    const base = isObject(current.data) ? { ...current.data } : {};
    delete base.studio;
    const data = toProjectData(studio, base);
    const dataBytes = this.assertSize(data);
    const progress = studioProgress(studio);

    const saved = await this.repository.saveData(projectId, dto.revision, {
      data: data as Prisma.InputJsonObject,
      dataBytes,
      progressCompleted: progress.completed,
      progressTotal: progress.total,
    });
    if (!saved) {
      const latest = await this.repository.findMeta(projectId);
      if (!latest)
        throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
      this.conflict(latest.revision);
    }
    return new SaveResultEntity(saved, storedBlobs);
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
    const source = await this.repository.findWithData(projectId);
    if (!source)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');

    const name =
      dto.name ?? `${source.name || 'Untitled Project'} - copy`.slice(0, 200);
    const data = isObject(source.data) ? source.data : {};
    const copy = await this.repository.transaction(async (tx) => {
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
      return created;
    });

    try {
      const idMap = await this.files.copyProjectFiles(
        projectId,
        copy.id,
        user.id,
      );
      if (idMap.size > 0) {
        // File ids referenced inside the data must point at the copies.
        let json = JSON.stringify(data);
        for (const [from, to] of idMap) json = json.split(from).join(to);
        const rewritten = JSON.parse(json) as JsonObject;
        await this.repository.saveData(copy.id, null, {
          data: rewritten as Prisma.InputJsonObject,
          dataBytes: byteSize(rewritten),
          progressCompleted: source.progressCompleted,
          progressTotal: source.progressTotal,
        });
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
    const current = await this.repository.findWithData(projectId);
    if (!current)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    const version = await this.repository.createVersion({
      projectId,
      revision: current.revision,
      data: isObject(current.data) ? current.data : {},
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
    const progress = progressOf(data);
    const saved = await this.repository.saveData(projectId, null, {
      data: data,
      dataBytes: byteSize(data),
      progressCompleted: progress.completed,
      progressTotal: progress.total,
    });
    if (!saved)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    await this.repository.logActivity({
      projectId,
      userId: user.id,
      type: ProjectActivityType.EDIT,
      details: { step_name: 'version restore', version_id: versionId },
    });
    return new SaveResultEntity(saved, 0);
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
      const progress = progressOf(next);
      const saved = await this.repository.saveData(
        projectId,
        row.revision,
        {
          data: next as Prisma.InputJsonObject,
          dataBytes,
          progressCompleted: progress.completed,
          progressTotal: progress.total,
        },
        tx,
      );
      if (!saved) this.conflict(row.revision);
      return saved;
    });
  }

  /**
   * Applies a change to the Studio graph on the server (load, mutate,
   * normalise, derive legacy keys), atomically with any other writer.
   */
  async mutateStudio(
    projectId: string,
    mutate: (studio: StudioProject) => StudioProject,
  ): Promise<ProjectMeta> {
    return this.mutateData(projectId, (data) => {
      const base = { ...data };
      delete base.studio;
      return toProjectData(mutate(loadStudioProject(data)), base);
    });
  }

  /** Sets a generated name unless the project was renamed meanwhile. */
  renameIfDefault(projectId: string, name: string): Promise<boolean> {
    return this.repository.renameIf(projectId, DEFAULT_PROJECT_NAME, name);
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

  /** 409 carrying the stored revision so the client can reload and retry. */
  private conflict(currentRevision: number): never {
    throw new HttpException(
      {
        message: 'The project was changed elsewhere; reload it and try again',
        code: ErrorCode.RevisionConflict,
        error: 'Conflict',
        meta: { currentRevision },
      },
      HttpStatus.CONFLICT,
    );
  }
}

export type { ProjectMeta };
