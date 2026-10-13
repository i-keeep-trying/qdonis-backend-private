import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { DesignService } from '../design/design.service';
import {
  approveSpecs,
  editConstraintValues,
  markConstraintsRunning,
  normName,
  replaceSpecs,
  settleConstraints,
  specsOf,
  type StageOutcome,
} from '../design/studio-specs.logic';
import { SimulationRunKind } from '../generated/prisma/enums';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsService } from '../projects/projects.service';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import { SimulationRunsService } from '../simulation/simulation-runs.service';
import type { EditConstraintsDto, ReplaceSpecsDto } from './dto/specs.dto';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const constraintsRunning = (studio: StudioProject) =>
  specsOf(stageNodeOnBranch(studio, 'specs'))?.constraints?.status ===
  'running';

const busy = () =>
  AppError.conflict(
    ErrorCode.StageRunning,
    'The constraints list is being generated. Wait for it to finish.',
  );

/**
 * The Specs stage of a branch as the workspace edits it: the key spec
 * table, its approval and the engineering constraints list. The graph
 * changes are the ones the Studio agent uses (`studio-specs.logic`).
 */
@Injectable()
export class SpecsService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly graph: StudioGraphService,
    private readonly design: DesignService,
    private readonly runs: SimulationRunsService,
  ) {}

  /** Replaces the spec table; a content change voids the approval. */
  async replace(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: ReplaceSpecsDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const names = dto.rows.map((r) => normName(r.name));
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `Two rows are named "${dto.rows[names.indexOf(duplicate)].name}".`,
      );
    }
    return this.apply(user, projectId, branchId, (studio) =>
      replaceSpecs(studio, dto),
    );
  }

  async approve(user: Actor, projectId: string, branchId: string) {
    await this.access.require(user, projectId, 'canEdit');
    return this.apply(user, projectId, branchId, (studio) =>
      approveSpecs(studio),
    );
  }

  async editConstraints(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: EditConstraintsDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.apply(user, projectId, branchId, (studio) => {
      if (constraintsRunning(studio)) throw busy();
      return editConstraintValues(studio, dto.items);
    });
  }

  /**
   * Queues the AI constraints list of the branch's specs (charged). The
   * specs node answers right away with `constraints.status: "running"`;
   * poll the stage until it settles.
   */
  async generateConstraints(
    user: Actor,
    projectId: string,
    branchId: string,
    notes?: string,
  ) {
    await this.design.precheckConstraints(user, projectId);
    const runId = randomUUID();
    let nodeId = '';
    const result = await this.apply(user, projectId, branchId, (studio) => {
      const node = stageNodeOnBranch(studio, 'specs');
      const specs = specsOf(node);
      if (!node || !specs || specs.rows.length === 0) {
        return {
          project: studio,
          result: {
            ok: false,
            summary: 'Add the key specs before generating constraints.',
          },
        };
      }
      if (constraintsRunning(studio)) throw busy();
      nodeId = node.id;
      return {
        project: markConstraintsRunning(studio, node.id, runId),
        result: { ok: true, summary: 'Generating constraints' },
      };
    });
    try {
      await this.runs.enqueue({
        runId,
        projectId,
        nodeId,
        actorId: user.id,
        kind: SimulationRunKind.constraints,
        run: {
          branchId: result.branchId,
          notes: notes?.trim() || undefined,
          actor: { id: user.id, role: user.role },
        },
      });
    } catch (error) {
      await this.projects.mutateStudio(
        projectId,
        null,
        (studio) =>
          settleConstraints(
            studio,
            nodeId,
            runId,
            'The constraints could not be queued — generate them again.',
          ) ?? studio,
        result.branchId,
      );
      throw error;
    }
    return result;
  }

  /**
   * Applies a specs change on `branchId` and answers the Studio
   * stage-action shape. A change on a stage with later work forks a branch.
   */
  private async apply(
    user: Actor,
    projectId: string,
    branchId: string,
    change: (studio: StudioProject) => StageOutcome,
  ) {
    let landed = branchId;
    let branchName = '';
    const meta = await this.projects.mutateStudio(
      projectId,
      user.id,
      (studio) => {
        const outcome = change(studio);
        if (!outcome.result.ok) {
          throw AppError.conflict(
            ErrorCode.StageInputMissing,
            outcome.result.summary,
          );
        }
        landed = outcome.project.activeBranchId;
        branchName = outcome.project.branches[landed]?.name ?? '';
        return outcome.project;
      },
      branchId,
    );
    const node = await this.graph.stage(projectId, user.id, landed, 'specs');
    if (!node) throw new Error('The specs result was not recorded');
    return {
      node,
      branchId: landed,
      forked: landed !== branchId,
      branchName,
      workspaceVersion: meta.revision,
    };
  }
}
