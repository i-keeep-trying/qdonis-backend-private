import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CircuitInfoService } from '../circuits/circuit-info.service';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsService } from '../projects/projects.service';
import {
  commitStage,
  patchNode,
  stageNodeOnBranch,
  type JsonObject,
  type StageNode,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import type { Permission } from '../projects/project-permissions';
import { generateNetlist } from '../simulation/netlist/netlist-generator';
import type { Dict } from '../simulation/netlist/py';
import type { DesignData } from '../simulation/simulation.types';
import { TopologiesService } from '../topologies/topologies.service';
import { toDisplayInventory } from '../visualization/library/visualization-format';
import type {
  CircuitEdit,
  VisualizationData,
} from '../visualization/visualization.types';
import type { RenderSchematicDto, SchematicEditDto } from './dto/schematic.dto';
import { applySchematic, type ApplyResult } from './library/apply';
import { readDrawing, readLayout } from './library/drawing-input';
import { libraryLayout, mergeLayouts } from './library/layout';
import { SheetNotFoundError, renderForTopology } from './library/render';
import {
  branchCircuit,
  fromStoredCircuit,
  toStoredCircuit,
} from './library/stored-circuit';
import { carriedDesignValues } from '../simulation/design-values';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const missing = (message: string) =>
  AppError.conflict(ErrorCode.StageInputMissing, message);
const shortName = (id: string) => id.replace(/^(dcdc|acdc|dcac)_/, '');

/** The branch's circuit as the schematic sees it. */
interface CircuitContext {
  node: StageNode;
  data: VisualizationData;
  topologyId: string;
  /** The branch's design, if any. */
  design: StageNode | null;
  /** Design values `[{ref, param, after}]` of the branch's design, if any. */
  rows: unknown;
  circuit: Dict;
  /** The topology's old hand-drawn schematic (seeds a fresh layout). */
  drawing: Dict;
}

/**
 * Synced schematic of the Circuit stage: the drawing is derived from the
 * circuit YAML (the one that is simulated), and edits made in the drawing
 * change that YAML. Positions are the only drawing-specific data.
 */
@Injectable()
export class SchematicService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly graph: StudioGraphService,
    private readonly topologies: TopologiesService,
    private readonly circuits: CircuitInfoService,
  ) {}

  /** One sheet of the branch's circuit, with the project layout over the library layout. */
  async render(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: RenderSchematicDto,
  ) {
    const ctx = await this.context(user, projectId, branchId, 'canView');
    const result = this.sheet(() =>
      renderForTopology(ctx.circuit, {
        recalculated: ctx.rows,
        layout: ctx.data.layout ?? null,
        fresh: dto.fresh,
        regroup: dto.regroup,
        sheet: dto.sheet ?? null,
        drawing: ctx.drawing,
      }),
    );
    return {
      schematic: result.schematic,
      layout: result.layout,
      sheet: result.sheet,
      sheets: result.sheets,
      palette: result.palette,
      basis: result.basis,
      groupsExplicit: result.groups_explicit,
      seededFromDrawing: result.seeded_from_drawing,
      libraryLayout: result.library_layout,
    };
  }

  /** What an edited drawing would change (nothing is stored). */
  async check(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: SchematicEditDto,
  ) {
    const ctx = await this.context(user, projectId, branchId, 'canEdit');
    const result = this.edit(ctx, dto);
    const structural = !result.layout_only && !result.errors.length;
    return {
      layoutOnly: result.layout_only,
      layout: result.layout,
      paramChanges: result.param_changes,
      added: result.added,
      removed: result.removed,
      rewired: result.rewired,
      changes: result.changes,
      errors: result.errors,
      inventory: structural ? this.inventory(result.circuit, ctx.rows) : null,
    };
  }

  /**
   * Applies an edited drawing: a layout-only change updates the Circuit node
   * in place; a circuit change records the edited circuit (forking when later
   * stages build on the current one). The edit is re-checked here.
   */
  async apply(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: SchematicEditDto,
  ) {
    const ctx = await this.context(user, projectId, branchId, 'canEdit');
    const result = this.edit(ctx, dto);
    if (result.errors.length) {
      throw AppError.badRequest(
        ErrorCode.SchematicInvalid,
        result.errors.join(' '),
      );
    }
    let data: VisualizationData;
    let summary = 'Schematic layout';
    if (result.layout_only) {
      data = { ...ctx.data, layout: result.layout };
    } else {
      const stored = toStoredCircuit(result.circuit);
      const edit: CircuitEdit = {
        id: randomUUID(),
        instruction: 'Edited in the schematic',
        summary: result.changes[0] ?? 'Schematic edited',
        changes: result.changes,
        added: result.added,
        removed: result.removed,
        appliedAt: new Date().toISOString(),
      };
      data = {
        ...ctx.data,
        customCircuit: stored,
        layout: result.layout,
        inventory: this.inventory(result.circuit, ctx.rows),
        netlist: this.netlist(stored),
        edits: [...(ctx.data.edits ?? []), edit],
        customStructure: true,
      };
      summary = edit.summary;
    }

    const carried = result.layout_only ? null : this.carryDesign(ctx, result);
    let forked = false;
    let branchName = '';
    let landed = branchId;
    const meta = await this.projects.mutateStudio(
      projectId,
      user.id,
      (studio) => {
        const current = stageNodeOnBranch(studio, 'visualization', branchId);
        if (
          !current ||
          current.id !== ctx.node.id ||
          current.rev !== ctx.node.rev
        ) {
          throw AppError.conflict(
            ErrorCode.RevisionConflict,
            'The circuit changed meanwhile. Reload the schematic and edit it again.',
          );
        }
        if (result.layout_only) {
          branchName = studio.branches[branchId]?.name ?? '';
          return patchNode(studio, current.id, {
            rev: current.rev + 1,
            data: data as unknown as JsonObject,
          });
        }
        const commit = commitStage(
          studio,
          'visualization',
          data as unknown as JsonObject,
          {
            source: 'user',
            summary,
            branchName: `${shortName(ctx.topologyId)} + edit`,
          },
        );
        forked = commit.forked;
        branchName = commit.branchName;
        landed = commit.project.activeBranchId;
        if (!carried) return commit.project;
        return commitStage(
          commit.project,
          'design',
          carried as unknown as JsonObject,
          {
            source: 'user',
            summary: 'Design carried over to the edited circuit',
          },
        ).project;
      },
      branchId,
    );
    const node = await this.graph.stage(
      projectId,
      user.id,
      landed,
      'visualization',
    );
    if (!node) throw new Error('The schematic edit was not recorded');
    return {
      node,
      branchId: landed,
      forked,
      branchName,
      workspaceVersion: meta.revision,
      changes: result.changes,
      designCarried: carried !== null,
    };
  }

  /**
   * The branch's design brought along to the edited circuit (values kept,
   * decks regenerated); null without a design, for an uploaded deck, or when
   * the edited circuit can not be netlisted with the design's values.
   */
  private carryDesign(
    ctx: CircuitContext,
    result: ApplyResult,
  ): DesignData | null {
    const design = ctx.design;
    if (design?.status !== 'ready') return null;
    const previous = design.data as unknown as DesignData;
    if (previous.origin === 'upload') return null;
    try {
      const carried = carriedDesignValues(
        Array.isArray(previous.recalculatedParameters)
          ? previous.recalculatedParameters
          : [],
        branchCircuit(
          toStoredCircuit(result.circuit),
          this.topologies.design(ctx.topologyId),
        ),
        result.param_changes,
      );
      if (!Object.keys(carried.decks).length) return null;
      return { ...previous, ...carried, aiEdit: null };
    } catch {
      return null;
    }
  }

  private async context(
    user: Actor,
    projectId: string,
    branchId: string,
    permission: Permission,
  ): Promise<CircuitContext> {
    await this.access.require(user, projectId, permission);
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const node = stageNodeOnBranch(studio, 'visualization', branchId);
    if (!node || node.status !== 'ready')
      throw missing('Pick a circuit first.');
    const data = node.data as unknown as VisualizationData;
    const topologyId = this.topologies.resolveId(data.topologyId);
    if (!topologyId)
      throw missing('The circuit does not name a library topology.');
    const design = stageNodeOnBranch(studio, 'design', branchId);
    const rows =
      design?.status === 'ready'
        ? (design.data as unknown as DesignData).recalculatedParameters
        : undefined;
    const library = this.topologies.design(topologyId);
    const circuit = data.customCircuit
      ? fromStoredCircuit(data.customCircuit, library.schematic)
      : library;
    const drawing = structuredClone(
      this.topologies.schematic(topologyId),
    ) as Dict;
    return { node, data, topologyId, design, rows, circuit, drawing };
  }

  private edit(ctx: CircuitContext, dto: SchematicEditDto): ApplyResult {
    const drawn = readDrawing(dto.schematic);
    const layout = mergeLayouts(
      libraryLayout(ctx.circuit),
      readLayout(dto.layout) ?? ctx.data.layout ?? null,
      ctx.circuit,
    );
    return this.sheet(() =>
      applySchematic(
        ctx.circuit,
        drawn,
        ctx.rows,
        dto.sheet ?? null,
        layout,
        ctx.drawing,
      ),
    );
  }

  /** A sheet the circuit does not have is a 404. */
  private sheet<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof SheetNotFoundError) {
        throw AppError.notFound(ErrorCode.SheetNotFound, error.message);
      }
      throw error;
    }
  }

  private inventory(circuit: Dict, rows: unknown) {
    return toDisplayInventory(
      this.circuits.inventory({
        circuit: toStoredCircuit(circuit),
        recalculated: Array.isArray(rows) ? (rows as unknown[]) : undefined,
      }),
    );
  }

  /** Base SPICE netlist of the edited circuit (null if it can not be generated). */
  private netlist(stored: Dict): string | null {
    try {
      return generateNetlist(fromStoredCircuit(stored, undefined), null)
        .netlist;
    } catch {
      return null;
    }
  }
}
