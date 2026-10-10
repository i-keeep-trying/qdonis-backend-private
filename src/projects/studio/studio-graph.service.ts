import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import type { Prisma } from '../../generated/prisma/client';
import { ProjectActivityType } from '../../generated/prisma/enums';
import { StoredFilesService } from '../../storage/stored-files.service';
import { byteSize, MAX_PROJECT_DATA_BYTES } from '../project-limits';
import { studioProgress } from '../project-progress';
import {
  type DbClient,
  type ProjectMeta,
  ProjectsRepository,
} from '../projects.repository';
import {
  branchViews,
  checkoutTarget,
  createBranch,
  type CreateBranchInput,
  deleteBranch,
  historyView,
  renameBranch,
  stageViews,
} from './studio-branches';
import {
  type JsonObject,
  type StageKind,
  type StageNode,
  stageNodeOnBranch,
  type StudioProject,
} from './studio-graph';
import {
  type GraphRows,
  StudioGraphRepository,
} from './studio-graph.repository';
import {
  heavyBlobName,
  loadStudioProject,
  normalizeForTables,
  parseStudioProject,
  projectDataFor,
  readStudioMeta,
  serializeProject,
} from './studio-persistence';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VIEW_OF: Record<StageKind, string> = {
  specs: 'specs',
  visualization: 'circuit',
  design: 'design',
  simulation: 'simulation',
  devices: 'devices',
  magnetics: 'magnetics',
  thermal: 'thermal',
};

export interface MutateOptions {
  /** Branch the change applies to; defaults to the caller's current one. */
  branchId?: string;
  /** Compare-and-swap: 409 when the stored revision differs. */
  expectedRevision?: number;
  /** Keys of `projects.data` outside the Studio to store instead (version restore). */
  baseData?: JsonObject;
  activity?: { stepName: string };
}

export interface MutateResult<T> {
  meta: ProjectMeta;
  project: StudioProject;
  value: T;
}

/**
 * The Studio graph of a project, stored in the `studio_*` tables and shared
 * by everyone with access. Branches and results are project-wide; which
 * branch a person is on is a per-user cursor. Every graph write runs in one
 * transaction holding the project row lock, bumps `projects.revision` and
 * refreshes the legacy summary keys and progress.
 *
 * Projects saved before the tables existed are moved into them the first
 * time they are opened.
 */
@Injectable()
export class StudioGraphService {
  private readonly logger = new Logger(StudioGraphService.name);

  constructor(
    private readonly rows: StudioGraphRepository,
    private readonly projects: ProjectsRepository,
    private readonly files: StoredFilesService,
  ) {}

  // --- reads -------------------------------------------------------------------

  /** Full graph with stage data, on the caller's branch (or `branchId`). */
  async load(
    projectId: string,
    userId: string,
    branchId?: string,
  ): Promise<StudioProject> {
    return this.read(projectId, userId, { withData: true, branchId });
  }

  /** Workspace summary (Studio top level): branches and stage states. */
  async workspace(
    projectId: string,
    userId: string,
    readOnly: boolean,
    branchId?: string,
  ) {
    const project = await this.read(projectId, userId, {
      withData: false,
      branchId,
    });
    const header = await this.rows.header(projectId);
    if (!header) throw this.projectNotFound();
    const active = project.activeBranchId;
    // Devices count as done when the branch's simulation already chose them.
    const simNode = stageNodeOnBranch(project, 'devices', active)
      ? null
      : stageNodeOnBranch(project, 'simulation', active);
    const simulation = simNode
      ? await this.rows.nodeWithData(projectId, simNode.id)
      : null;
    const hasSimDevices = Boolean(
      simulation?.status === 'ready' &&
      (isObject(simulation.data.device_selection) ||
        isObject(simulation.data.deviceSelection)),
    );
    return {
      projectId,
      name: header.name,
      readOnly,
      version: header.revision,
      activeBranchId: active,
      branches: branchViews(project),
      stages: stageViews(project, active, hasSimDevices),
      defaultView: this.defaultView(project, active),
      // The first chat message is sent by the chat agent, which is not served yet.
      pendingInitialPrompt: null,
    };
  }

  /** Node of `stage` on a branch with its data; null when the stage has no result. */
  async stage(
    projectId: string,
    userId: string,
    branchId: string,
    stage: StageKind,
  ) {
    const project = await this.read(projectId, userId, {
      withData: false,
      branchId,
    });
    const light = stageNodeOnBranch(project, stage, branchId);
    if (!light) return null;
    const node = await this.rows.nodeWithData(projectId, light.id);
    return node ? this.nodeView(node) : null;
  }

  async history(projectId: string, userId: string) {
    const project = await this.read(projectId, userId, { withData: false });
    return historyView(project, project.activeBranchId);
  }

  /** Graph as stored before the tables (version 1), for version snapshots. */
  async snapshot(projectId: string, userId: string): Promise<StudioProject> {
    return serializeProject(await this.load(projectId, userId));
  }

  // --- navigation (per user; viewers may navigate) -------------------------------

  async setActiveBranch(
    projectId: string,
    userId: string,
    branchId: string,
  ): Promise<void> {
    await this.ensureImported(projectId);
    if (!(await this.rows.branchExists(projectId, branchId))) {
      throw AppError.notFound(ErrorCode.BranchNotFound, 'Branch not found');
    }
    try {
      await this.rows.setCursor(projectId, userId, branchId);
    } catch (error) {
      // The branch was deleted between the check and the write.
      if (isForeignKeyViolation(error)) {
        throw AppError.notFound(ErrorCode.BranchNotFound, 'Branch not found');
      }
      throw error;
    }
  }

  async checkout(projectId: string, userId: string, nodeId: string) {
    const project = await this.read(projectId, userId, { withData: false });
    const target = checkoutTarget(project, nodeId);
    await this.setActiveBranch(projectId, userId, target.branchId);
    return target;
  }

  // --- branch changes (editors) ---------------------------------------------------

  async createBranch(
    projectId: string,
    userId: string,
    input: CreateBranchInput,
  ) {
    const result = await this.mutate(
      projectId,
      userId,
      (project) => {
        const created = createBranch(project, input);
        return { project: created.project, value: created.branch.id };
      },
      { activity: { stepName: 'branches' } },
    );
    return this.branchView(result.project, result.value);
  }

  async renameBranch(
    projectId: string,
    userId: string,
    branchId: string,
    name: string,
  ) {
    const result = await this.mutate(
      projectId,
      userId,
      (project) => ({
        project: renameBranch(project, branchId, name).project,
        value: branchId,
      }),
      { activity: { stepName: 'branches' } },
    );
    return this.branchView(result.project, branchId);
  }

  /** Deletes a branch and the results only it reached; returns the caller's branch. */
  async deleteBranch(
    projectId: string,
    userId: string,
    branchId: string,
  ): Promise<{ activeBranchId: string }> {
    const result = await this.mutate(
      projectId,
      userId,
      (project) => {
        const deleted = deleteBranch(project, branchId);
        return { project: deleted.project, value: deleted.removedNodeIds };
      },
      { activity: { stepName: 'branches' } },
    );
    // Saved versions may still point at these results' waveforms.
    const versions = await this.projects.listVersions(projectId);
    if (versions.length === 0)
      void this.removeHeavyBlobs(projectId, result.value);
    return { activeBranchId: result.project.activeBranchId };
  }

  // --- graph writes ------------------------------------------------------------------

  /**
   * Applies `change` to the graph atomically: lock the project row, load the
   * graph on the caller's branch, change it, write only what differs, move the
   * caller's cursor to the branch the change ended on (a fork opens a new
   * branch), and refresh revision, legacy keys and progress.
   */
  async mutate<T = undefined>(
    projectId: string,
    userId: string | null,
    change: (
      project: StudioProject,
    ) => { project: StudioProject; value: T } | StudioProject,
    options: MutateOptions = {},
  ): Promise<MutateResult<T>> {
    try {
      return await this.projects.transaction(async (tx) => {
        const locked = await this.projects.lockData(projectId, tx);
        if (!locked) throw this.projectNotFound();
        if (
          options.expectedRevision !== undefined &&
          locked.revision !== options.expectedRevision
        ) {
          throw revisionConflict(locked.revision);
        }
        const data = isObject(locked.data) ? locked.data : {};
        const rows = await this.importIfNeeded(projectId, data, tx);
        const before = await this.assemble(
          projectId,
          userId,
          rows,
          data,
          options.branchId,
          tx,
        );

        const outcome = change(before);
        const { project: changed, value } =
          'project' in outcome && 'value' in outcome
            ? outcome
            : { project: outcome, value: undefined as T };
        const after = normalizeForTables(
          parseStudioProject(serializeProject(changed)),
        );

        const base = options.baseData ?? stripStudio(data);
        const nextData = projectDataFor(after, base);
        const bytes = byteSize(nextData) + byteSize(after.nodes);
        if (bytes > MAX_PROJECT_DATA_BYTES) throw tooLarge(bytes);

        await this.rows.writeDiff(projectId, userId, rows, after, tx);
        // A change pinned to another branch only moves the caller when it forked.
        const moved = after.activeBranchId !== before.activeBranchId;
        if (userId && (options.branchId === undefined || moved)) {
          await this.rows.setCursor(
            projectId,
            userId,
            after.activeBranchId,
            tx,
          );
        }
        const progress = studioProgress(after);
        const meta = await this.projects.saveData(
          projectId,
          locked.revision,
          {
            data: nextData as Prisma.InputJsonObject,
            dataBytes: byteSize(nextData),
            progressCompleted: progress.completed,
            progressTotal: progress.total,
          },
          tx,
        );
        if (!meta) throw revisionConflict(locked.revision);
        if (options.activity && userId) {
          await this.projects.logActivity(
            {
              projectId,
              userId,
              type: ProjectActivityType.EDIT,
              details: { step_name: options.activity.stepName },
            },
            tx,
          );
        }
        return { meta, project: after, value };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCode.BranchNameTaken,
          'A branch with this name already exists',
        );
      }
      throw error;
    }
  }

  /** Writes a fresh graph for a project created in the same transaction. */
  async initialise(
    projectId: string,
    userId: string,
    project: StudioProject,
    tx: DbClient,
  ): Promise<void> {
    const graph = normalizeForTables(project);
    await this.rows.writeDiff(projectId, userId, emptyRows(), graph, tx);
    await this.rows.setCursor(projectId, userId, graph.activeBranchId, tx);
  }

  /** Copies the graph into another project (duplicate); the source is imported first. */
  async copyInto(
    fromProjectId: string,
    toProjectId: string,
    userId: string,
    tx: DbClient,
  ): Promise<void> {
    await this.rows.copy(fromProjectId, toProjectId, tx);
    const first = await tx.studioBranch.findFirst({
      where: { projectId: toProjectId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (first) await this.rows.setCursor(toProjectId, userId, first.id, tx);
  }

  rewriteNodeData(projectId: string, ids: ReadonlyMap<string, string>) {
    return this.rows.rewriteNodeData(projectId, ids);
  }

  /** Imports a project saved before the tables existed (no-op otherwise). */
  async ensureImported(projectId: string): Promise<void> {
    if ((await this.rows.countBranches(projectId)) > 0) return;
    await this.projects.transaction(async (tx) => {
      const locked = await this.projects.lockData(projectId, tx);
      if (!locked) throw this.projectNotFound();
      const data = isObject(locked.data) ? locked.data : {};
      if ((await this.rows.countBranches(projectId, tx)) > 0) return;
      const graph = normalizeForTables(
        parseStudioProject(serializeProject(loadStudioProject(data))),
      );
      await this.rows.writeDiff(projectId, null, emptyRows(), graph, tx);
      const nextData = projectDataFor(graph, stripStudio(data));
      const progress = studioProgress(graph);
      const saved = await this.projects.saveData(
        projectId,
        locked.revision,
        {
          data: nextData as Prisma.InputJsonObject,
          dataBytes: byteSize(nextData),
          progressCompleted: progress.completed,
          progressTotal: progress.total,
        },
        tx,
      );
      if (!saved) throw revisionConflict(locked.revision);
      this.logger.log(
        `Moved the Studio graph of ${projectId} into tables (${Object.keys(graph.nodes).length} results, ${graph.branchOrder.length} branches)`,
      );
    });
  }

  // --- helpers ---------------------------------------------------------------------

  private async read(
    projectId: string,
    userId: string,
    options: { withData: boolean; branchId?: string },
  ): Promise<StudioProject> {
    await this.ensureImported(projectId);
    const rows = await this.rows.load(projectId, {
      withData: options.withData,
    });
    let data: JsonObject;
    if (options.withData) {
      // Full read: the old chat messages kept in data.studio come along.
      const full = await this.projects.findWithData(projectId);
      if (!full) throw this.projectNotFound();
      data = isObject(full.data) ? full.data : {};
    } else {
      const header = await this.rows.header(projectId);
      if (!header) throw this.projectNotFound();
      data = {
        studio: { initialPrompt: header.initialPrompt, focus: header.focus },
      };
    }
    return this.assemble(projectId, userId, rows, data, options.branchId);
  }

  /** In-transaction import, returning the rows to diff against. */
  private async importIfNeeded(
    projectId: string,
    data: JsonObject,
    tx: DbClient,
  ): Promise<GraphRows> {
    const rows = await this.rows.load(projectId, { withData: true }, tx);
    if (rows.branchOrder.length > 0) return rows;
    const graph = normalizeForTables(
      parseStudioProject(serializeProject(loadStudioProject(data))),
    );
    await this.rows.writeDiff(projectId, null, emptyRows(), graph, tx);
    return this.rows.load(projectId, { withData: true }, tx);
  }

  /** Rows + Studio meta -> graph, with the active branch resolved for the user. */
  private async assemble(
    projectId: string,
    userId: string | null,
    rows: GraphRows,
    data: JsonObject,
    branchId: string | undefined,
    db?: DbClient,
  ): Promise<StudioProject> {
    if (branchId !== undefined && !rows.branches[branchId]) {
      throw AppError.notFound(ErrorCode.BranchNotFound, 'Branch not found');
    }
    const cursor = userId
      ? await this.rows.cursor(projectId, userId, db)
      : null;
    const active =
      branchId ??
      (cursor && rows.branches[cursor] ? cursor : rows.branchOrder[0]);
    const meta = readStudioMeta(data);
    return {
      version: 1,
      nodes: rows.nodes,
      branches: rows.branches,
      branchOrder: rows.branchOrder,
      activeBranchId: active,
      focus: meta.focus,
      messages: meta.messages,
      ...(meta.initialPrompt ? { initialPrompt: meta.initialPrompt } : {}),
      createdAt: meta.createdAt,
    };
  }

  private defaultView(project: StudioProject, branchId: string): string {
    if (project.focus) return VIEW_OF[project.focus];
    const branch = project.branches[branchId];
    const head = branch?.headId ? project.nodes[branch.headId] : undefined;
    return head ? VIEW_OF[head.stage] : 'specs';
  }

  private branchView(project: StudioProject, branchId: string) {
    const view = branchViews(project).find((b) => b.id === branchId);
    if (!view)
      throw AppError.notFound(ErrorCode.BranchNotFound, 'Branch not found');
    return view;
  }

  private nodeView(node: StageNode) {
    return {
      id: node.id,
      parentId: node.parentId,
      stage: node.stage,
      status: node.status,
      error: node.error ?? null,
      rev: node.rev,
      data: node.data,
      source: node.source,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      summary: node.summary ?? null,
      stale: false,
    };
  }

  /** Waveform blobs of results that no branch reaches any more. */
  private async removeHeavyBlobs(projectId: string, nodeIds: string[]) {
    for (const nodeId of nodeIds) {
      try {
        const blob = await this.files.findStageBlob(
          projectId,
          heavyBlobName(nodeId),
        );
        if (blob) await this.files.remove(blob);
      } catch (error) {
        this.logger.warn(
          `Could not remove the stored waveforms of ${projectId}/${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private projectNotFound() {
    return AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
  }
}

const emptyRows = (): GraphRows => ({
  nodes: {},
  branches: {},
  branchOrder: [],
});

function stripStudio(data: JsonObject): JsonObject {
  const base = { ...data };
  delete base.studio;
  return base;
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2003'
  );
}

function tooLarge(bytes: number): HttpException {
  return AppError.tooLarge(
    ErrorCode.ProjectDataTooLarge,
    `Project data is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_PROJECT_DATA_BYTES / 1024 / 1024} MB. Large results must be stored as files.`,
  );
}

/** 409 carrying the stored revision so the client can reload and retry. */
export function revisionConflict(currentRevision: number): HttpException {
  return new HttpException(
    {
      message: 'The project was changed elsewhere; reload it and try again',
      code: ErrorCode.RevisionConflict,
      error: 'Conflict',
      meta: { currentRevision },
    },
    HttpStatus.CONFLICT,
  );
}
