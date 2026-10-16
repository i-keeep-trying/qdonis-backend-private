import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { forkNote, type StageResult } from '../design/studio-specs.logic';
import {
  getSpectrumData,
  runVoltageScan,
} from '../engines/emc/emc-calculations';
import {
  AVAILABLE_CORES,
  AVAILABLE_MATERIALS,
} from '../engines/magnetics/magnetics-engine';
import {
  calculateMTBFComponents,
  calculateSystemMTBF,
  ENVIRONMENT_FACTORS,
} from '../engines/reliability/mtbf-calculations';
import type {
  SelectedPart,
  ThermalComponent,
  ThermalProperties,
} from '../engines/reliability/reliability.types';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectsService } from '../projects/projects.service';
import {
  commitStage,
  stageNodeOnBranch,
  type StageKind,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import { SimulationArtifactsService } from '../simulation/simulation-artifacts.service';
import { SourcingService } from '../sourcing/sourcing.service';
import {
  CIRCUIT_DATA_PROVIDER,
  type CircuitDataProvider,
} from './circuit-data.provider';
import type {
  EmcParametersDto,
  EmcSpectrumDto,
  MtbfDto,
  RunThermalDto,
} from './dto/stages.dto';
import type {
  MagneticPartStageDto,
  RunBomStageDto,
  RunMagneticsStageDto,
  RunMtbfStageDto,
  RunThermalStageDto,
} from './dto/stage-runs.dto';
import {
  type MagneticPartInput,
  type MagneticsOptions,
  planMagnetics,
  type StagePlan,
} from './magnetics.stage';
import {
  type BomLine,
  type LineChoicePatch,
  type PartLookup,
  partKey,
  partsToLookUp,
  planBom,
  sourcedPart,
} from './bom.stage';
import { type MtbfOptions, planMtbf } from './mtbf.stage';
import { planThermal } from './thermal.stage';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/**
 * Studio magnetics / thermal stages and the stateless engineering
 * calculators (EMC, MTBF). Domain failures (missing inputs) answer 200 with
 * `ok: false` and a payload explaining what is needed, which is what the
 * Studio agent relays to the user; HTTP errors are for auth and validation.
 */
/** A part of the web's magnetics form -> the stage's (core-style) part input. */
const magneticPart = (p: MagneticPartStageDto): MagneticPartInput => ({
  ref: p.ref,
  kind: p.kind,
  role: p.role ?? undefined,
  inductance_uh: p.inductanceUh ?? undefined,
  turns_ratio: p.turnsRatio ?? undefined,
  fsw_khz: p.fswKhz,
  duty: p.duty ?? undefined,
  i_dc_a: p.iDcA ?? undefined,
  i_ripple_pp_a: p.iRipplePpA ?? undefined,
  i_peak_a: p.iPeakA ?? undefined,
  i_rms_a: p.iRmsA ?? undefined,
  v_primary_v: p.vPrimaryV ?? undefined,
  power_w: p.powerW ?? undefined,
  unipolar: p.unipolar,
});

@Injectable()
export class StudioStagesService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly repository: ProjectsRepository,
    @Inject(CIRCUIT_DATA_PROVIDER)
    private readonly circuit: CircuitDataProvider,
    private readonly artifacts: SimulationArtifactsService,
    private readonly graph: StudioGraphService,
    private readonly sourcing: SourcingService,
  ) {}

  private readonly logger = new Logger(StudioStagesService.name);

  /**
   * BOM plan with the selected devices looked up on Mouser by exact part
   * number. Best effort: without Mouser (not configured, rate limited,
   * failing) the lines stay unpriced and are looked up on the next run.
   * Parts not listed are retried on a plain rebuild (no line changes).
   */
  private async planBomSourced(
    user: Actor,
    projectId: string,
    studio: Awaited<ReturnType<ProjectsService['loadStudio']>>,
    changes: Record<string, LineChoicePatch>,
  ) {
    const plan = await planBom(studio, changes, this.circuit);
    if (!plan.ok) return plan;
    const needed = partsToLookUp(
      plan.data.lines as BomLine[],
      plan.data.lookups as Record<string, PartLookup>,
      Object.keys(changes).length === 0,
    );
    if (!needed.length) return plan;
    const fresh: Record<string, PartLookup> = {};
    for (const partNumber of needed) {
      try {
        const found = await this.sourcing.exactPart(
          { userId: user.id, projectId },
          partNumber,
        );
        fresh[partKey(partNumber)] = {
          part: found ? sourcedPart(found) : null,
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        this.logger.warn(
          `BOM lookup of ${partNumber} stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    return Object.keys(fresh).length
      ? planBom(studio, changes, this.circuit, fresh)
      : plan;
  }

  /** `branchId` defaults to the caller's branch (the Studio chat passes its own). */
  async runMagnetics(
    user: Actor,
    projectId: string,
    dto: MagneticsOptions,
    branchId?: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    await this.artifacts.hydrate(projectId, studio);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'magnetics',
      await planMagnetics(studio, dto, this.circuit),
    );
  }

  async runThermal(
    user: Actor,
    projectId: string,
    dto: RunThermalDto,
    branchId?: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    await this.artifacts.hydrate(projectId, studio);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'thermal',
      await planThermal(studio, dto, this.circuit),
    );
  }

  /** MTBF of the branch parts, or of entered parts (Studio agent). */
  async runMtbf(
    user: Actor,
    projectId: string,
    options: MtbfOptions,
    branchId?: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'mtbf',
      await planMtbf(studio, options, this.circuit),
    );
  }

  /** BOM of the branch parts with line changes (Studio agent). */
  async runBom(
    user: Actor,
    projectId: string,
    changes: Record<string, LineChoicePatch>,
    branchId?: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'bom',
      await this.planBomSourced(user, projectId, studio, changes),
    );
  }

  // --- branch stage runs (qdonis-web) ---------------------------------------------

  /** Magnetics stage of a branch, from its circuit or from entered parts. */
  async runMagneticsStage(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: RunMagneticsStageDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const unknownCore = Object.entries(dto.coreOverrides ?? {}).find(
      ([, core]) => !AVAILABLE_CORES.includes(core),
    );
    if (unknownCore) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `${unknownCore[1]} is not in the core library.`,
      );
    }
    const parts = dto.origin === 'input' ? (dto.inputs ?? []) : [];
    if (dto.origin === 'input' && parts.length === 0) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Describe at least one magnetic part.',
      );
    }
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    if (
      dto.origin === 'circuit' &&
      !stageNodeOnBranch(studio, 'visualization', branchId)
    ) {
      throw AppError.conflict(
        ErrorCode.StageInputMissing,
        'Choose a topology first, or describe the parts.',
      );
    }
    await this.artifacts.hydrate(projectId, studio);
    const s = dto.settings;
    const plan = await planMagnetics(
      studio,
      {
        material: s.material ?? undefined,
        maxFluxDensity: s.maxFluxDensityT ?? undefined,
        currentDensity: s.currentDensity ?? undefined,
        windowUtilization: s.windowUtilization ?? undefined,
        maxTempRiseC: s.maxTempRiseC ?? undefined,
        ambientC: s.ambientC,
        coreOverrides: dto.coreOverrides,
        fromCircuit: dto.origin === 'circuit',
        parts: parts.map(magneticPart),
        partOverrides: dto.partOverrides?.map(magneticPart),
        clearOverrides: dto.clearAllOverrides ? true : dto.clearOverrides,
      },
      this.circuit,
    );
    return this.commitStageRun(user, projectId, branchId, 'magnetics', plan);
  }

  /** Thermal stage of a branch: from its simulation, its devices, or entered losses. */
  async runThermalStage(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: RunThermalStageDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const inputs = dto.origin === 'input' ? dto.inputs : undefined;
    if (
      dto.origin === 'input' &&
      (inputs?.devices.length ?? 0) + (inputs?.magnetics.length ?? 0) === 0
    ) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Add at least one heat source.',
      );
    }
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    if (
      dto.origin === 'simulation' &&
      stageNodeOnBranch(studio, 'simulation', branchId)?.status !== 'ready'
    ) {
      throw AppError.conflict(
        ErrorCode.StageInputMissing,
        'Run a simulation first, or enter the losses.',
      );
    }
    await this.artifacts.hydrate(projectId, studio);
    const s = dto.settings;
    const plan = await planThermal(
      studio,
      {
        ambientC: s.ambientC,
        marginC: s.marginC ?? undefined,
        maxJunctionC: s.maxJunctionC ?? undefined,
        rthCs: s.rthCs ?? undefined,
        strategy: s.strategy,
        outputPowerW: s.outputPowerW ?? undefined,
        fromSimulation: dto.origin === 'simulation',
        inputs: inputs
          ? {
              devices: inputs.devices.map((d) => ({
                ref: d.ref,
                kind: d.kind,
                loss_w: d.lossW,
                technology: d.technology,
              })),
              magnetics: inputs.magnetics.map((m) => ({
                ref: m.ref,
                loss_w: m.lossW,
                temp_rise_c: m.tempRiseC ?? undefined,
              })),
              other_losses: inputs.otherLosses.map((o) => ({
                ref: o.ref,
                category: o.category,
                loss_w: o.lossW,
              })),
              output_power_w: inputs.outputPowerW ?? undefined,
            }
          : undefined,
      },
      this.circuit,
    );
    if (plan.ok) {
      // The user's output power (null: from the load / specs), for the settings form.
      plan.data.userOutputPowerW = s.outputPowerW;
    }
    return this.commitStageRun(user, projectId, branchId, 'thermal', plan);
  }

  /** MTBF stage of a branch: its circuit's parts, or entered parts. */
  async runMtbfStage(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: RunMtbfStageDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const parts = dto.origin === 'input' ? (dto.inputs ?? []) : [];
    if (dto.origin === 'input' && parts.length === 0) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Add at least one part.',
      );
    }
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const s = dto.settings;
    const previous = rec(
      rec(stageNodeOnBranch(studio, 'mtbf', branchId)?.data).settings,
    ).overrides;
    // The form sends the full set: drop the overrides it no longer has.
    const overrides: Record<string, boolean | null> = Object.fromEntries(
      Object.keys(rec(previous)).map((ref) => [ref, null]),
    );
    Object.assign(overrides, s.overrides);
    const plan = await planMtbf(
      studio,
      {
        predictionMethod: s.predictionMethod,
        environment: s.environment,
        overrides,
        parts: parts,
        fromCircuit: dto.origin === 'circuit',
      },
      this.circuit,
    );
    return this.commitStageRun(user, projectId, branchId, 'mtbf', plan);
  }

  /** BOM stage of a branch: rebuilt from the branch, with the line changes applied. */
  async runBomStage(
    user: Actor,
    projectId: string,
    branchId: string,
    dto: RunBomStageDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    const changes: Record<string, LineChoicePatch> = {};
    for (const { ref, ...change } of dto.changes ?? []) {
      if (ref in changes) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          `${ref} is changed twice.`,
        );
      }
      changes[ref] = change.part
        ? {
            ...change,
            part: { ...change.part, currency: change.part.currency ?? null },
          }
        : (change as LineChoicePatch);
    }
    const studio = await this.projects.loadStudio(projectId, user.id, branchId);
    const plan = await this.planBomSourced(user, projectId, studio, changes);
    return this.commitStageRun(user, projectId, branchId, 'bom', plan);
  }

  /** Commits a stage plan on `branchId` and answers the Studio stage-action shape. */
  private async commitStageRun(
    user: Actor,
    projectId: string,
    branchId: string,
    stage: 'magnetics' | 'thermal' | 'mtbf' | 'bom',
    plan: StagePlan,
  ) {
    if (!plan.ok) {
      throw AppError.conflict(ErrorCode.StageInputMissing, plan.result.summary);
    }
    let landed = branchId;
    let forked = false;
    let branchName = '';
    const meta = await this.projects.mutateStudio(
      projectId,
      user.id,
      (studio) => {
        const commit = commitStage(studio, stage, plan.data, {
          source: 'user',
          summary: plan.summary,
        });
        landed = commit.project.activeBranchId;
        forked = commit.forked;
        branchName = commit.branchName;
        return { ...commit.project, focus: stage };
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

  /** Stores the result on the branch it was computed from (forks if needed). */
  private async commit(
    projectId: string,
    userId: string,
    branchId: string,
    stage: StageKind,
    plan: StagePlan,
  ): Promise<
    StageResult & { revision: number | null; branchId: string; forked: boolean }
  > {
    if (!plan.ok)
      return { ...plan.result, revision: null, branchId, forked: false };
    let result: StageResult = plan.result({});
    let landed = branchId;
    let forked = false;
    const meta = await this.projects.mutateStudio(
      projectId,
      userId,
      (studio) => {
        const commit = commitStage(studio, stage, plan.data, {
          summary: plan.summary,
        });
        result = plan.result(forkNote(commit));
        landed = commit.project.activeBranchId;
        forked = commit.forked;
        return { ...commit.project, focus: stage };
      },
      branchId,
    );
    return { ...result, revision: meta.revision, branchId: landed, forked };
  }

  // --- MTBF ----------------------------------------------------------------------

  mtbfOptions() {
    return {
      methods: Object.keys(ENVIRONMENT_FACTORS),
      environments: Object.fromEntries(
        Object.entries(ENVIRONMENT_FACTORS).map(([method, envs]) => [
          method,
          Object.keys(envs),
        ]),
      ),
    };
  }

  /** Stateless MTBF prediction from the given parts and thermal data. */
  calculateMtbf(dto: MtbfDto) {
    return this.mtbf(dto, dto.parts ?? [], dto.thermal ?? []);
  }

  /** MTBF of the project's selected parts; results are stored on the project. */
  async projectMtbf(user: Actor, projectId: string, dto: MtbfDto) {
    await this.access.require(user, projectId, 'canEdit');
    const data = await this.dataOf(projectId);
    // Stored parts come from older flows: keep only well-formed ones.
    const stored = Array.isArray(data.selectedParts)
      ? (data.selectedParts as unknown[])
          .map(rec)
          .filter(
            (p) =>
              typeof p.id === 'string' &&
              typeof p.componentName === 'string' &&
              typeof p.componentType === 'string',
          )
          .map((p) => p as unknown as SelectedPart)
      : [];
    const parts = dto.parts ?? stored;
    const thermal = dto.thermal ?? this.thermalOf(data);
    const outcome = this.mtbf(dto, parts, thermal);
    const meta = await this.projects.mutateData(projectId, (current) => ({
      ...current,
      mtbfComponents: outcome.components,
      mtbfSummary: {
        systemMTBF: outcome.mtbf,
        totalFailureRate: outcome.totalFailureRate,
        predictionMethod: dto.predictionMethod,
        environment: dto.environment,
      },
    }));
    return { ...outcome, revision: meta.revision };
  }

  private mtbf(
    dto: MtbfDto,
    partsIn: Array<
      Partial<SelectedPart> & {
        id: string;
        componentName: string;
        componentType: string;
      }
    >,
    thermalIn:
      Array<{ name: string } & Partial<ThermalProperties>> | ThermalComponent[],
  ) {
    const environments = rec(ENVIRONMENT_FACTORS[dto.predictionMethod]);
    if (!(dto.environment in environments)) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `Unknown environment for ${dto.predictionMethod}; see GET /calculators/mtbf/options`,
      );
    }
    if (partsIn.length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'No parts selected for the MTBF estimate',
      );
    }
    const selectedParts: SelectedPart[] = partsIn.map((p) => ({
      id: p.id,
      manufacturer: p.manufacturer ?? '',
      partNumber: p.partNumber ?? '',
      description: p.description ?? '',
      mountingType: p.mountingType ?? '',
      availability: p.availability ?? '',
      pricingTiers: p.pricingTiers ?? [],
      datasheetLink: p.datasheetLink ?? '',
      electricalSpecs: p.electricalSpecs ?? {},
      isSelected: true,
      componentName: p.componentName,
      componentType: p.componentType.toLowerCase(),
      componentId: p.componentId ?? p.id,
      isCircuitComponent: p.isCircuitComponent ?? true,
      selectionSource: p.selectionSource ?? 'suggested',
      includeInMTBF: p.includeInMTBF,
    }));
    const thermalComponents: ThermalComponent[] = thermalIn.map((t) =>
      'thermalProperties' in t
        ? t
        : {
            id: t.name,
            name: t.name,
            type: 'ic',
            position: { x: 0, y: 0 },
            isSelected: true,
            thermalProperties: {
              ...EMPTY_THERMAL,
              ...(t as Partial<ThermalProperties>),
            },
          },
    );
    const components = calculateMTBFComponents({
      selectedParts,
      thermalComponents,
      predictionMethod: dto.predictionMethod,
      environment: dto.environment,
      defaultVoltage: dto.defaultVoltage,
      defaultCurrent: dto.defaultCurrent,
      switchingFrequency: dto.switchingFrequency,
    });
    const system = calculateSystemMTBF(components);
    return {
      components: system.componentsWithContributions,
      mtbf: Number.isFinite(system.mtbf) ? system.mtbf : null,
      totalFailureRate: system.totalFailureRate,
    };
  }

  private thermalOf(data: Record<string, unknown>): ThermalComponent[] {
    return Array.isArray(data.thermalComponents)
      ? (data.thermalComponents as unknown[])
          .map(rec)
          .filter(
            (t) =>
              typeof t.name === 'string' &&
              typeof t.thermalProperties === 'object',
          )
          .map((t) => t as unknown as ThermalComponent)
      : [];
  }

  // --- EMC / magnetics catalogue ------------------------------------------------------

  emcScan(dto: EmcParametersDto) {
    return runVoltageScan({ ...dto });
  }

  emcSpectrum(dto: EmcSpectrumDto) {
    const { voltage, ...params } = dto;
    return getSpectrumData(params, voltage);
  }

  magneticsOptions() {
    return { cores: AVAILABLE_CORES, materials: AVAILABLE_MATERIALS };
  }

  private async dataOf(projectId: string): Promise<Record<string, unknown>> {
    const project = await this.repository.findWithData(projectId);
    if (!project)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    return rec(project.data);
  }
}

const EMPTY_THERMAL: ThermalProperties = {
  thermalResistance: '',
  temperature: '25',
  powerLoss: '',
  voltageStress: '',
  currentStress: '',
  efficiency: '',
  thermalTimeConstant: '',
  maxOperatingTemp: '',
  derating: '',
  coolingRequirement: '',
};
