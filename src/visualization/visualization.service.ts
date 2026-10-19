import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { generateNetlist } from '../simulation/netlist/netlist-generator';
import { CircuitInfoService } from '../circuits/circuit-info.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsService } from '../projects/projects.service';
import {
  commitStage,
  stageNodeOnBranch,
  type CommitResult,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import { TopologiesService } from '../topologies/topologies.service';
import {
  toDisplayInventory,
  toEngineCircuit,
} from './library/visualization-format';
import type { VisualizationData } from './visualization.types';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const shortName = (id: string) => id.replace(/^(dcdc|acdc|dcac)_/, '');

/** The Circuit stage: picking a library topology for a branch. */
@Injectable()
export class VisualizationService {
  private readonly logger = new Logger(VisualizationService.name);

  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly graph: StudioGraphService,
    private readonly topologies: TopologiesService,
    private readonly circuits: CircuitInfoService,
  ) {}

  /** Stage data for a library topology: schematic + parts inventory. */
  build(topologyId: string, reason: string | null = null): VisualizationData {
    return {
      topologyId,
      topologyName: this.topologies.title(topologyId),
      reason,
      circuit: toEngineCircuit(this.topologies.schematic(topologyId)),
      netlist: this.netlist(topologyId),
      inventory: toDisplayInventory(this.circuits.inventory({ topologyId })),
      edits: [],
      customStructure: false,
      customCircuit: null,
      layout: null,
    };
  }

  /** Base SPICE netlist, as qdonis-core `/api/visualize` returned it (null if generation fails). */
  private netlist(topologyId: string): string | null {
    try {
      return generateNetlist(this.topologies.design(topologyId), null).netlist;
    } catch (error) {
      this.logger.warn(
        `Netlist generation failed for ${topologyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Records the chosen topology on the branch. A branch that already has a
   * different circuit keeps it: the pick opens a new branch instead.
   */
  async selectTopology(
    user: Actor,
    projectId: string,
    branchId: string,
    requested: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const topologyId = this.topologies.requireId(requested);
    const data = this.build(topologyId);

    let commit: CommitResult | null = null;
    const meta = await this.projects.mutateStudio(
      projectId,
      user.id,
      (studio) => {
        const current = stageNodeOnBranch(studio, 'visualization', branchId);
        const otherCircuit =
          current !== null && current.data.topologyId !== topologyId;
        commit = commitStage(
          studio,
          'visualization',
          data as unknown as Record<string, unknown>,
          {
            source: 'user',
            summary: data.topologyName,
            forceFork: otherCircuit,
            branchName: otherCircuit
              ? `alt-${shortName(topologyId)}`
              : undefined,
          },
        );
        return commit.project;
      },
      branchId,
    );
    const result = commit as CommitResult | null;
    if (!result) throw new Error('The Studio graph was not changed');

    const landed = result.project.activeBranchId;
    const node = await this.graph.stage(
      projectId,
      user.id,
      landed,
      'visualization',
    );
    return {
      node,
      branchId: landed,
      forked: result.forked,
      branchName: result.branchName,
      workspaceVersion: meta.revision,
    };
  }
}
