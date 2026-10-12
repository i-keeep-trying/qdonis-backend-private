import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsService } from '../projects/projects.service';
import {
  commitStage,
  patchNode,
  stageNodeOnBranch,
  type CommitOptions,
  type JsonObject,
  type StageKind,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import { StoredFilesService } from '../storage/stored-files.service';
import { TopologiesService } from '../topologies/topologies.service';
import {
  specsToParameters,
  type SpecsData,
} from '../design/studio-specs.logic';
import { SimulationRunKind } from '../generated/prisma/enums';
import { ComputeService } from './compute/compute.service';
import { sanitizePreparedDeck } from './ngspice/ngspice.runner';
import {
  DesignSizingService,
  type DesignEditRunInput,
  type DesignRunInput,
} from './sizing/design-sizing.service';
import {
  deviceSelectionView,
  mergeOverrides,
  stressEntries,
} from './devices.format';
import { catalogue, type Preference } from './loss/device-selection';
import { semiconductorTypesFromYaml } from './loss/loss-engine';
import { SimulationArtifactsService } from './simulation-artifacts.service';
import {
  applyParameterUpdates,
  currentValue,
  designParameters,
  hasComponent,
  syncedDecks,
} from './design-values';
import type {
  DesignDecksDto,
  DesignValueDto,
  SelectDevicesDto,
  VerifySimulationDto,
} from './dto/simulation.dto';
import { generateAnalysisCirs } from './netlist/netlist-generator';
import {
  lossAnalysisView,
  pendingSimulation,
  summaryOf,
} from './simulation.format';
import {
  SimulationRunsService,
  type SimulationRunInput,
} from './simulation-runs.service';
import {
  DECK_KINDS,
  type DeckKind,
  type DesignData,
  type RecalculatedParameter,
  type SimulationData,
  type WaveformSet,
} from './simulation.types';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const PREFERENCES = new Set<Preference>(['auto', 'mosfet', 'igbt']);

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Decks with LF line ends (core normalises `\r\n` / `\r`). */
const normalizeDecks = (
  decks: Partial<Record<DeckKind, string>>,
): Partial<Record<DeckKind, string>> =>
  Object.fromEntries(
    Object.entries(decks)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      .map(([k, v]) => [k, v.replace(/\r\n?/g, '\n')]),
  );

const missing = (message: string) =>
  AppError.conflict(ErrorCode.StageInputMissing, message);

/** Commands an uploaded deck may not run (old frontend `UNSAFE_CONTROL`). */
const UNSAFE_CONTROL =
  /^\s*(shell|source|\.include|\.lib|cd|load|write|wrdata\s+\/|set\s+sourcepath)\b/im;

/** Analysis of an uploaded deck, from its directives (old frontend `classifyDeck`). */
function deckKindOf(text: string): DeckKind {
  const t = text.toLowerCase();
  if (/^\s*\.?tran\b/m.test(t)) return 'transient';
  if (/^\s*\.?ac\b/m.test(t)) return 'ac';
  if (/^\s*\.?(dc|op)\b/m.test(t)) return 'dc';
  return 'transient';
}

/** Decks of a design node (only non-empty strings). */
function decksOf(data: JsonObject): Partial<Record<DeckKind, string>> {
  const decks: Partial<Record<DeckKind, string>> = {};
  const raw = rec(data.decks);
  for (const kind of DECK_KINDS) {
    const deck = raw[kind];
    if (typeof deck === 'string' && deck.trim()) decks[kind] = deck;
  }
  return decks;
}

/**
 * Design and Simulation stages. The design builds the ngspice decks from
 * the branch's library topology (qdonis-core `generate_analysis_cirs`);
 * the simulation queues an ngspice run (qdonis-core `/api/simulate/rerun`)
 * whose result lands on the node when it finishes.
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly graph: StudioGraphService,
    private readonly topologies: TopologiesService,
    private readonly files: StoredFilesService,
    private readonly runs: SimulationRunsService,
    private readonly compute: ComputeService,
    private readonly artifacts: SimulationArtifactsService,
    private readonly sizing: DesignSizingService,
  ) {}

  // --- design ------------------------------------------------------------------

  /**
   * Design stage. With specs on the branch the AI sizes the components (a
   * queued run: the node is `running` until it lands); without specs the
   * decks use the library values.
   */
  async runDesign(
    user: Actor,
    projectId: string,
    branchId: string,
    notes?: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const specs = stageNodeOnBranch(studio, 'specs', branchId);
    const parameters =
      specs?.status === 'ready'
        ? specsToParameters(specs.data as unknown as SpecsData)
        : undefined;
    if (parameters) {
      // Old frontend: the agent's guidance reaches the optimiser with the specs.
      if (notes?.trim()) parameters.designer_notes = notes.trim();
      return this.queueDesign(user, projectId, branchId, parameters);
    }
    return this.commit(user, projectId, branchId, 'design', (studio) => {
      const vis = stageNodeOnBranch(studio, 'visualization', branchId);
      const topologyId =
        vis?.status === 'ready' && typeof vis.data.topologyId === 'string'
          ? this.topologies.resolveId(vis.data.topologyId)
          : null;
      if (!topologyId)
        throw missing('Pick a circuit before running the design.');
      if (vis?.data.customStructure === true) {
        throw AppError.unavailable(
          ErrorCode.StageNotAvailable,
          'Designing an edited circuit is not available yet.',
        );
      }
      const design = this.topologies.design(topologyId);
      const parameters = designParameters(design);
      const decks = Object.fromEntries(
        Object.entries(generateAnalysisCirs(design, 'all').analysis_cirs).map(
          ([kind, deck]) => [kind, sanitizePreparedDeck(deck)],
        ),
      ) as Partial<Record<DeckKind, string>>;
      if (Object.keys(decks).length === 0) {
        throw AppError.conflict(
          ErrorCode.StageFailed,
          'The topology defines no analyses to simulate.',
        );
      }
      const name = this.topologies.title(topologyId);
      const data: DesignData = {
        topologyId,
        decks: normalizeDecks(decks),
        recalculatedParameters: parameters,
        quickParamsLine: null,
        reasoning: null,
        origin: 'optimizer',
        fileName: null,
        metadata: { topology: topologyId, sizing: 'library defaults' },
      };
      return {
        data: data as unknown as JsonObject,
        options: { source: 'user', summary: `${name} decks` },
      };
    });
  }

  /** Commits a running design node and queues the AI sizing for it. */
  private async queueDesign(
    user: Actor,
    projectId: string,
    branchId: string,
    parameters: Record<string, unknown>,
  ) {
    await this.sizing.precheck(user, projectId);
    const runId = randomUUID();
    let topologyId = '';
    const result = await this.commit(
      user,
      projectId,
      branchId,
      'design',
      (studio) => {
        const vis = stageNodeOnBranch(studio, 'visualization', branchId);
        const id =
          vis?.status === 'ready'
            ? this.topologies.resolveId(vis.data.topologyId)
            : null;
        if (!id) throw missing('Pick a circuit before running the design.');
        if (vis?.data.customStructure === true) {
          throw AppError.unavailable(
            ErrorCode.StageNotAvailable,
            'Designing an edited circuit is not available yet.',
          );
        }
        topologyId = id;
        return {
          data: {
            runId,
            topologyId: id,
            decks: {},
            recalculatedParameters: [],
            quickParamsLine: null,
            reasoning: null,
            origin: 'optimizer',
            fileName: null,
            metadata: { topology: id },
          },
          options: {
            source: 'user',
            status: 'running',
            summary: `${this.topologies.title(id)} sizing`,
          },
        };
      },
    );
    const input: DesignRunInput = {
      topologyId,
      parameters,
      actor: { id: user.id, role: user.role },
    };
    try {
      await this.runs.enqueue({
        runId,
        projectId,
        nodeId: result.node.id,
        actorId: user.id,
        run: input,
        kind: SimulationRunKind.design,
      });
    } catch (error) {
      await this.runs.failNode(
        projectId,
        result.node.id,
        runId,
        'The design could not be queued — run it again.',
      );
      throw error;
    }
    return result;
  }

  /**
   * AI edit of the branch's decks: `modify` follows an instruction (core
   * `/api/design/modify-netlist`), `fix` repairs them (`/api/netlist/ai-fix`).
   * Queued like the sizing; the node is `running` until the result lands.
   */
  async editDesign(
    user: Actor,
    projectId: string,
    branchId: string,
    mode: 'modify' | 'fix',
    instruction: string,
  ) {
    await this.sizing.precheck(user, projectId);
    const runId = randomUUID();
    let input: DesignEditRunInput | null = null;
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const specs = stageNodeOnBranch(studio, 'specs', branchId);
    const parameters =
      (specs?.status === 'ready'
        ? specsToParameters(specs.data as unknown as SpecsData)
        : undefined) ?? {};
    const result = await this.commit(
      user,
      projectId,
      branchId,
      'design',
      (current) => {
        const design = stageNodeOnBranch(current, 'design', branchId);
        if (
          !design ||
          design.status !== 'ready' ||
          Object.keys(decksOf(design.data)).length === 0
        ) {
          throw missing(
            'There is no design netlist to change yet. Run the design first.',
          );
        }
        const previous = { ...(design.data as unknown as DesignData) };
        delete (previous as Partial<{ runId: string }>).runId;
        input = {
          mode,
          previous,
          parameters,
          instruction,
          actor: { id: user.id, role: user.role },
        };
        return {
          data: { ...design.data, runId },
          options: {
            source: 'user',
            status: 'running',
            summary:
              mode === 'modify'
                ? `Modifying: ${instruction.slice(0, 60)}`
                : 'AI netlist fix',
          },
        };
      },
    );
    const queued = input as DesignEditRunInput | null;
    if (!queued) throw new Error('The design edit was not recorded');
    try {
      await this.runs.enqueue({
        runId,
        projectId,
        nodeId: result.node.id,
        actorId: user.id,
        run: queued,
        kind:
          mode === 'modify'
            ? SimulationRunKind.design_modify
            : SimulationRunKind.design_fix,
      });
    } catch (error) {
      await this.runs.failNode(
        projectId,
        result.node.id,
        runId,
        'The design change could not be queued — run it again.',
      );
      throw error;
    }
    return result;
  }

  /**
   * A netlist the user attached becomes the branch's design (old frontend
   * `importNetlist`): one deck, simulated against `topologyId`'s
   * measurement structure. Decks with shell / file commands are refused.
   */
  async importDesign(
    user: Actor,
    projectId: string,
    branchId: string,
    input: { topologyId: string; fileName: string; text: string },
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const topologyId = this.topologies.requireId(input.topologyId);
    const text = input.text.replace(/\r\n?/g, '\n').trim();
    if (UNSAFE_CONTROL.test(text)) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'The netlist contains commands that are not allowed for uploaded files (shell/source/include/file writes).',
      );
    }
    const kind = deckKindOf(text);
    const data: DesignData = {
      topologyId,
      decks: { [kind]: text },
      recalculatedParameters: [],
      quickParamsLine: null,
      reasoning: null,
      origin: 'upload',
      fileName: input.fileName,
      metadata: { topology: topologyId, imported: 'true' },
    };
    return this.commit(user, projectId, branchId, 'design', () => ({
      data: data as unknown as JsonObject,
      options: { source: 'upload', summary: `Imported ${input.fileName}` },
    }));
  }

  /** Replaces some decks of the branch's design (edited by hand). */
  async updateDesignDecks(
    user: Actor,
    projectId: string,
    branchId: string,
    edited: DesignDecksDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.commit(user, projectId, branchId, 'design', (studio) => {
      const design = stageNodeOnBranch(studio, 'design', branchId);
      if (!design || design.status !== 'ready') {
        throw missing('Run the design before editing its decks.');
      }
      const decks = decksOf(design.data);
      for (const kind of DECK_KINDS) {
        const deck = edited[kind];
        if (deck === undefined) continue;
        if (!(kind in decks)) {
          throw AppError.badRequest(
            ErrorCode.ValidationFailed,
            `This design has no ${kind.toUpperCase()} deck.`,
          );
        }
        decks[kind] = deck.replace(/\r\n?/g, '\n');
      }
      return {
        data: { ...design.data, decks },
        options: { source: 'user', summary: 'Edited decks' },
      };
    });
  }

  /**
   * Sets component values and rebuilds the decks from the library topology
   * with every edited value (qdonis-core `/api/simulate/sync_parameters`).
   * Hand-edited decks are replaced, as in core.
   */
  async setDesignValues(
    user: Actor,
    projectId: string,
    branchId: string,
    values: DesignValueDto[],
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.commit(user, projectId, branchId, 'design', (studio) => {
      const node = stageNodeOnBranch(studio, 'design', branchId);
      if (!node || node.status !== 'ready') {
        throw missing('Run the design before editing its values.');
      }
      const topologyId = this.topologies.resolveId(node.data.topologyId);
      if (!topologyId) {
        throw missing('The design does not name a library topology.');
      }
      const library = this.topologies.design(topologyId);
      const rows: RecalculatedParameter[] = Array.isArray(
        node.data.recalculatedParameters,
      )
        ? (node.data.recalculatedParameters as RecalculatedParameter[]).map(
            (row) => ({ ...row }),
          )
        : [];
      for (const edit of values) {
        if (!hasComponent(library, edit.ref)) {
          throw AppError.badRequest(
            ErrorCode.ValidationFailed,
            `The circuit has no component ${edit.ref}.`,
          );
        }
        const row = rows.find(
          (r) => r.ref === edit.ref && r.param === edit.param,
        );
        if (row) row.after = edit.value;
        else {
          rows.push({
            ref: edit.ref,
            param: edit.param,
            before: currentValue(library, edit.ref, edit.param) ?? '',
            after: edit.value,
            unit: null,
          });
        }
      }

      // Only changed rows: the table shows rounded values (6 digits).
      const updates = new Map<string, Map<string, string>>();
      for (const row of rows) {
        if (row.after === row.before) continue;
        const params = updates.get(row.ref) ?? new Map<string, string>();
        params.set(row.param, row.after);
        updates.set(row.ref, params);
      }
      applyParameterUpdates(library, updates);
      const decks = syncedDecks(library);
      return {
        data: {
          ...node.data,
          decks: normalizeDecks(decks),
          recalculatedParameters: rows,
        },
        options: {
          source: 'user',
          summary:
            `Values edited: ${values.map((v) => v.ref).join(', ')}`.slice(
              0,
              200,
            ),
        },
      };
    });
  }

  // --- simulation -----------------------------------------------------------------

  /** Queues ngspice on the design's decks; the node is `running` until done. */
  async runSimulation(
    user: Actor,
    projectId: string,
    branchId: string,
    analyses: DeckKind[],
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const runId = randomUUID();
    let run: SimulationRunInput | null = null;
    const result = await this.commit(
      user,
      projectId,
      branchId,
      'simulation',
      (studio) => {
        const design = stageNodeOnBranch(studio, 'design', branchId);
        if (!design || design.status !== 'ready') {
          throw missing('Run the design before simulating.');
        }
        const topologyId = this.topologies.resolveId(design.data.topologyId);
        if (!topologyId) {
          throw missing('The design does not name a library topology.');
        }
        const decks = decksOf(design.data);
        const wanted = DECK_KINDS.filter((kind) => analyses.includes(kind));
        const absent = wanted.filter((kind) => !(kind in decks));
        if (absent.length) {
          throw AppError.badRequest(
            ErrorCode.ValidationFailed,
            `The design has no ${absent.map((k) => k.toUpperCase()).join('/')} deck.`,
          );
        }
        const topologyName = this.topologies.title(topologyId);
        const prior = rec(
          stageNodeOnBranch(studio, 'simulation', branchId)?.data
            .deviceSelection,
        );
        run = {
          devicePreference: PREFERENCES.has(prior.preference as Preference)
            ? (prior.preference as Preference)
            : 'auto',
          deviceOverrides: mergeOverrides(prior, undefined),
          topologyId,
          topologyName,
          analyses: wanted,
          analysisCirs: Object.fromEntries(wanted.map((k) => [k, decks[k]])),
          componentModels: {},
          junctionTemperature: null,
        };
        const data = pendingSimulation({
          runId,
          topologyId,
          topologyName,
          analyses: wanted,
        });
        return {
          data: data as unknown as JsonObject,
          options: {
            source: 'user',
            status: 'running',
            summary: wanted.map((k) => k.toUpperCase()).join(' + '),
          },
        };
      },
    );

    const queued = run as SimulationRunInput | null;
    if (!queued) throw new Error('The simulation was not recorded');
    try {
      await this.runs.enqueue({
        runId,
        projectId,
        nodeId: result.node.id,
        actorId: user.id,
        run: queued,
      });
    } catch (error) {
      this.logger.error(
        `Could not queue simulation ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.runs.failNode(
        projectId,
        result.node.id,
        runId,
        'The simulation could not be queued — run it again.',
      );
      throw error;
    }
    return result;
  }

  /** Plot samples of a finished simulation (stored in S3, off the node). */
  async waveforms(
    user: Actor,
    projectId: string,
    nodeId: string,
  ): Promise<WaveformSet> {
    await this.access.require(user, projectId);
    const node = await this.graph.node(projectId, nodeId);
    if (!node || node.stage !== 'simulation') {
      throw AppError.notFound(
        ErrorCode.NodeNotFound,
        'This simulation no longer exists.',
      );
    }
    if (node.status !== 'ready') return { plots: {} };
    return this.artifacts.waveforms(projectId, nodeId);
  }

  /**
   * Whether a requested netlist change shows in a finished simulation (core
   * `/api/simulate/verify-rerun`). Analysis only; nothing is changed.
   */
  async verifySimulation(
    user: Actor,
    projectId: string,
    nodeId: string,
    dto: VerifySimulationDto,
  ) {
    await this.access.require(user, projectId);
    const node = await this.graph.node(projectId, nodeId);
    if (!node || node.stage !== 'simulation') {
      throw AppError.notFound(
        ErrorCode.NodeNotFound,
        'This simulation no longer exists.',
      );
    }
    if (node.status !== 'ready') {
      throw missing('The simulation has not finished.');
    }
    const data = node.data as unknown as Partial<SimulationData>;
    const { verification } = await this.sizing.verify({
      actor: user,
      projectId,
      userRequest: dto.userRequest.trim(),
      before: normalizeDecks(dto.beforeDecks),
      after: normalizeDecks(dto.afterDecks),
      executedSha256: data.executedDecksSha256 ?? null,
      metadata: data.metadata ?? {},
      results: data.results ?? {},
    });
    return {
      verification: {
        status: verification.status,
        summary: verification.summary,
        evidence: verification.evidence.map((e) => ({
          source: e.source,
          analysisType: e.analysis_type,
          claim: e.claim,
          observed: e.observed,
          supports: e.supports,
        })),
        limitations: verification.limitations,
      },
    };
  }

  // --- devices ---------------------------------------------------------------------

  /**
   * Devices stage: picks the switches and diodes from the device library,
   * from entered stresses or (without them) on the branch simulation's
   * waveforms. The simulation's selection and losses are updated too.
   */
  async selectDevices(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: SelectDevicesDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const previous = stageNodeOnBranch(studio, 'devices', branchId);
    const sim = stageNodeOnBranch(studio, 'simulation', branchId);
    const tj = 100.0;
    this.assertParts(dto.overrides);

    if (dto.inputs?.length) {
      const result = await this.compute.run('selectFromStresses', {
        entries: stressEntries(dto.inputs),
        tj,
        preference: dto.preference ?? 'auto',
        overrides: mergeOverrides(
          dto.preference ? null : rec(previous?.data).selection,
          dto.overrides,
        ),
      });
      if (!result.success) {
        const missing = Object.entries(result.missing_inputs)
          .map(([ref, need]) => `${ref}: ${need.join(', ')}`)
          .join('; ');
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          `Missing inputs — ${missing}`,
        );
      }
      const selection = deviceSelectionView(result);
      const losses = lossAnalysisView({
        assumptions: {
          junction_temperature_c: tj,
          plecs_model: result.loss_analysis.assumptions.waveforms,
          default_mosfet: '',
          default_diode: '',
        },
        components: result.loss_analysis.components,
      });
      return this.commit(user, projectId, branchId, 'devices', () => ({
        data: {
          inputs: dto.inputs,
          selection,
          losses: losses?.components ?? [],
          loss_analysis: result.loss_analysis,
        },
        options: { source: 'user', summary: 'Devices selected' },
      }));
    }

    if (!sim || sim.status !== 'ready') {
      throw missing('Run a simulation first, or enter the device stresses.');
    }
    const artifacts = await this.artifacts.load(projectId, sim.id);
    if (!artifacts?.timeSeriesZip) {
      this.files.assertEnabled();
      throw missing(
        'The raw waveforms of this simulation were not kept. Re-run the simulation, or enter the device stresses.',
      );
    }
    const topologyId = this.topologies.resolveId(
      rec(sim.data.metadata).topology,
    );
    const { selection: core, lossAnalysis } = await this.compute.run(
      'selectDevices',
      {
        zipBase64: artifacts.timeSeriesZip,
        tj,
        deviceTypes: topologyId
          ? semiconductorTypesFromYaml(this.topologies.design(topologyId))
          : null,
        preference: dto.preference ?? 'auto',
        overrides: mergeOverrides(
          dto.preference ? null : sim.data.deviceSelection,
          dto.overrides,
        ),
      },
    );
    const selection = deviceSelectionView(core);
    const losses = lossAnalysisView(lossAnalysis);
    return this.commit(user, projectId, branchId, 'devices', (current) => {
      // Keep the simulation's view in step with the chosen parts.
      const node = stageNodeOnBranch(current, 'simulation', branchId);
      let project = current;
      if (node && node.id === sim.id) {
        const data = node.data as unknown as SimulationData;
        project = patchNode(current, node.id, {
          rev: node.rev + 1,
          data: {
            ...node.data,
            deviceSelection: selection,
            loss_analysis: lossAnalysis,
            lossAnalysis: losses,
            summary: summaryOf(
              data.analyses,
              data.measurements,
              data.plots.length,
              losses,
            ),
          },
        });
      }
      return {
        project,
        data: {
          inputs: [],
          selection,
          losses: losses?.components ?? [],
          loss_analysis: lossAnalysis,
        },
        options: { source: 'user', summary: 'Devices selected' },
      };
    });
  }

  /** Overridden parts must exist in the device library. */
  private assertParts(overrides: Record<string, string> | undefined): void {
    for (const [ref, part] of Object.entries(overrides ?? {})) {
      if (
        !catalogue().some((p) => p.part.toUpperCase() === part.toUpperCase())
      ) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          `${part} is not a library part (for ${ref}).`,
        );
      }
    }
  }

  // --- helpers ---------------------------------------------------------------------

  /**
   * Commits a stage result on `branchId` (forking when later work builds on
   * it) and answers the Studio stage-action shape.
   */
  private async commit(
    user: Actor,
    projectId: string,
    branchId: string,
    stage: StageKind,
    build: (studio: StudioProject) => {
      data: JsonObject;
      options: CommitOptions;
      /** Graph to commit onto (other nodes updated alongside). */
      project?: StudioProject;
    },
  ) {
    let forked = false;
    let branchName = '';
    let landed = branchId;
    const meta = await this.projects.mutateStudio(
      projectId,
      user.id,
      (studio) => {
        const { data, options, project } = build(studio);
        const commit = commitStage(project ?? studio, stage, data, options);
        forked = commit.forked;
        branchName = commit.branchName;
        landed = commit.project.activeBranchId;
        return commit.project;
      },
      branchId,
    );
    const node = await this.graph.stage(projectId, user.id, landed, stage);
    if (!node) throw new Error(`The ${stage} result was not recorded`);
    return {
      node,
      branchId: landed,
      forked,
      branchName,
      workspaceVersion: meta.revision,
    };
  }
}
