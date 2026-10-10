import { Inject, Injectable } from '@nestjs/common';

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
import { commitStage, type StageKind } from '../projects/studio/studio-graph';
import {
  CIRCUIT_DATA_PROVIDER,
  type CircuitDataProvider,
} from './circuit-data.provider';
import type {
  EmcParametersDto,
  EmcSpectrumDto,
  MtbfDto,
  RunMagneticsDto,
  RunThermalDto,
} from './dto/stages.dto';
import { planMagnetics, type StagePlan } from './magnetics.stage';
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
@Injectable()
export class StudioStagesService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly repository: ProjectsRepository,
    @Inject(CIRCUIT_DATA_PROVIDER)
    private readonly circuit: CircuitDataProvider,
  ) {}

  async runMagnetics(user: Actor, projectId: string, dto: RunMagneticsDto) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'magnetics',
      await planMagnetics(studio, dto, this.circuit),
    );
  }

  async runThermal(user: Actor, projectId: string, dto: RunThermalDto) {
    await this.access.require(user, projectId, 'canEdit');
    const studio = await this.projects.loadStudio(projectId, user.id);
    return this.commit(
      projectId,
      user.id,
      studio.activeBranchId,
      'thermal',
      await planThermal(studio, dto, this.circuit),
    );
  }

  /** Stores the result on the branch it was computed from (forks if needed). */
  private async commit(
    projectId: string,
    userId: string,
    branchId: string,
    stage: StageKind,
    plan: StagePlan,
  ): Promise<StageResult & { revision: number | null }> {
    if (!plan.ok) return { ...plan.result, revision: null };
    let result: StageResult = plan.result({});
    const meta = await this.projects.mutateStudio(
      projectId,
      userId,
      (studio) => {
        const commit = commitStage(studio, stage, plan.data, {
          summary: plan.summary,
        });
        result = plan.result(forkNote(commit));
        return { ...commit.project, focus: stage };
      },
      branchId,
    );
    return { ...result, revision: meta.revision };
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
