import {
  HttpException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import { DesignService } from '../design/design.service';
import {
  applyGeneratedConstraints,
  settleConstraints,
  specsOf,
} from '../design/studio-specs.logic';
import type { Prisma, StoredFile } from '../generated/prisma/client';
import type { Role } from '../generated/prisma/enums';
import { ProjectsService } from '../projects/projects.service';
import { patchNode, type StudioProject } from '../projects/studio/studio-graph';
import { StoredFilesService } from '../storage/stored-files.service';
import { TopologiesService } from '../topologies/topologies.service';
import { SimulationArtifactsService } from './simulation-artifacts.service';
import { SimulationRunKind } from '../generated/prisma/enums';
import { ComputeService } from './compute/compute.service';
import {
  DesignSizingService,
  type DesignEditRunInput,
  type DesignRunInput,
} from './sizing/design-sizing.service';
import { deviceSelectionView } from './devices.format';
import type { Overrides, Preference } from './loss/device-selection';
import { semiconductorTypesFromYaml } from './loss/loss-engine';
import type { RerunInput, RerunResult } from './rerun.pipeline';
import { completedSimulation } from './simulation.format';
import {
  SimulationRunsRepository,
  type ClaimedRun,
} from './simulation-runs.repository';
import type { DeckKind, SimulationData, WaveformSet } from './simulation.types';
import { branchCircuit } from '../schematic/library/stored-circuit';

/** What a run needs; stored as `simulation_runs.input`. */
export interface SimulationRunInput {
  topologyId: string;
  topologyName: string;
  analyses: DeckKind[];
  analysisCirs: Partial<Record<DeckKind, string>>;
  componentModels: Record<string, string>;
  junctionTemperature: number | null;
  /** Device selection after the run (kept from the branch's previous one). */
  devicePreference?: Preference;
  deviceOverrides?: Overrides | null;
  /** The branch's edited circuit (absent: the library topology). */
  circuit?: Record<string, unknown>;
}

/** Constraints generation of a specs node; stored as `simulation_runs.input`. */
export interface ConstraintsRunInput {
  branchId: string;
  notes?: string;
  actor: { id: string; role: Role };
}

const INTERRUPTED_CONSTRAINTS =
  'The constraints generation was interrupted — generate them again.';

/** A claim lasts this long unless renewed. */
const LEASE_MS = 2 * 60_000;
const RENEW_MS = 30_000;
const POLL_MS = 5_000;
/** Claims of one run (a lease that expired means its worker died). */
const MAX_ATTEMPTS = 2;

const INTERRUPTED =
  'The simulation was interrupted before it finished — run it again.';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Executes queued simulations. Every instance runs this worker: runs are
 * claimed from `simulation_runs` with `SKIP LOCKED`, so they are shared
 * across instances and survive restarts. ngspice and the result pipeline run
 * in a worker thread inside a scratch directory that is always removed;
 * waveforms go to S3, the light result onto the Studio node.
 */
@Injectable()
export class SimulationRunsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SimulationRunsService.name);
  private timer?: NodeJS.Timeout;
  private active = 0;
  private draining = false;
  private drainAgain = false;
  private stopped = true;

  constructor(
    private readonly runs: SimulationRunsRepository,
    private readonly projects: ProjectsService,
    private readonly files: StoredFilesService,
    private readonly topologies: TopologiesService,
    private readonly compute: ComputeService,
    private readonly sizing: DesignSizingService,
    private readonly design: DesignService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly artifacts: SimulationArtifactsService,
  ) {}

  private settings(): AppConfiguration['simulation'] {
    return this.config.get('simulation', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.config.get('app', { infer: true }).isTest) return;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref();
    this.kick();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Queues a run for a node that already carries `data.runId = runId`. */
  async enqueue(input: {
    runId: string;
    projectId: string;
    nodeId: string;
    actorId: string;
    run:
      | SimulationRunInput
      | DesignRunInput
      | DesignEditRunInput
      | ConstraintsRunInput;
    kind?: SimulationRunKind;
  }): Promise<void> {
    await this.runs.create({
      id: input.runId,
      projectId: input.projectId,
      nodeId: input.nodeId,
      kind: input.kind ?? SimulationRunKind.simulation,
      createdById: input.actorId,
      input: input.run as unknown as Prisma.InputJsonObject,
    });
    this.kick();
  }

  /** Marks a node whose run could not be queued (or ran) as failed. */
  async failNode(
    projectId: string,
    nodeId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    await this.updateNode(projectId, nodeId, runId, (studio, node) =>
      patchNode(studio, nodeId, {
        status: 'error',
        error: message,
        rev: node.rev + 1,
      }),
    );
  }

  /** Claims as many runs as there are free slots. Never throws. */
  kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        this.kick();
      }
    });
  }

  private async drain(): Promise<void> {
    try {
      const { concurrency } = this.settings();
      while (!this.stopped && this.active < concurrency) {
        const claimed = await this.runs.claim(
          concurrency - this.active,
          LEASE_MS,
        );
        if (claimed.length === 0) return;
        for (const run of claimed) {
          this.active += 1;
          void this.execute(run).finally(() => {
            this.active -= 1;
            this.kick();
          });
        }
      }
    } catch (error) {
      this.logger.error(`Could not claim simulation runs: ${describe(error)}`);
    }
  }

  /** Renews the run's lease while it works; clear the returned timer when done. */
  private holdLease(run: ClaimedRun): NodeJS.Timeout {
    const renew = setInterval(() => {
      this.runs
        .renew(run.id, LEASE_MS)
        .catch((error: unknown) =>
          this.logger.warn(
            `Lease renewal of run ${run.id} failed: ${describe(error)}`,
          ),
        );
    }, RENEW_MS);
    renew.unref();
    return renew;
  }

  private async execute(run: ClaimedRun): Promise<void> {
    if (run.kind === SimulationRunKind.constraints) {
      await this.executeConstraints(run);
      return;
    }
    if (run.attempts > MAX_ATTEMPTS) {
      await this.fail(run, INTERRUPTED);
      return;
    }
    if (run.kind !== SimulationRunKind.simulation) {
      await this.executeDesign(run);
      return;
    }
    const renew = this.holdLease(run);
    const started = Date.now();
    try {
      const input = run.input as SimulationRunInput;
      const yamlData = branchCircuit(
        input.circuit,
        this.topologies.design(input.topologyId),
      );
      const result = await this.simulate({
        topologyId: input.topologyId,
        yamlData,
        analysisCirs: input.analysisCirs,
        componentModels: input.componentModels,
        junctionTemperature: input.junctionTemperature,
      });
      const devices = await this.selectDevices(input, yamlData, result);
      const { data, waveforms } = completedSimulation(
        {
          runId: run.id,
          topologyName: input.topologyName,
          analyses: input.analyses,
        },
        result,
        devices,
      );
      await this.complete(run, data, waveforms, result.timeSeriesZip);
      await this.runs.finish(run.id, null);
      this.logger.log(
        `Simulation ${run.id} (${input.topologyId}) finished in ${Math.round((Date.now() - started) / 1000)} s`,
      );
    } catch (error) {
      this.logger.warn(`Simulation ${run.id} failed: ${describe(error)}`);
      await this.fail(run, this.userMessage(error));
    } finally {
      clearInterval(renew);
    }
  }

  /** Design sizing / AI edits: the result replaces the running design node's data. */
  private async executeDesign(run: ClaimedRun): Promise<void> {
    const renew = this.holdLease(run);
    try {
      const data =
        run.kind === SimulationRunKind.design
          ? await this.sizing.size(run.input as DesignRunInput, run.projectId)
          : await this.sizing.edit(
              run.input as DesignEditRunInput,
              run.projectId,
            );
      await this.updateNode(run.projectId, run.nodeId, run.id, (studio, node) =>
        patchNode(studio, run.nodeId, {
          status: 'ready',
          error: null,
          data: data as unknown as Record<string, unknown>,
          rev: node.rev + 1,
        }),
      );
      await this.runs.finish(run.id, null);
    } catch (error) {
      const what = {
        [SimulationRunKind.design]: 'Design sizing',
        [SimulationRunKind.design_modify]: 'Design modification',
        [SimulationRunKind.design_fix]: 'AI fix',
        [SimulationRunKind.simulation]: 'Simulation',
        [SimulationRunKind.constraints]: 'Constraints generation',
      }[run.kind];
      this.logger.warn(`${what} ${run.id} failed: ${describe(error)}`);
      await this.fail(run, `${what} failed: ${describe(error)}`);
    } finally {
      clearInterval(renew);
    }
  }

  /**
   * Engineering constraints of a specs node. The list lands on the run's
   * branch (a regenerated list is a new version of the specs); the node
   * itself stays `ready`, only its constraints are `running`.
   */
  private async executeConstraints(run: ClaimedRun): Promise<void> {
    const input = run.input as ConstraintsRunInput;
    if (run.attempts > MAX_ATTEMPTS) {
      await this.failConstraints(run, input, INTERRUPTED_CONSTRAINTS);
      return;
    }
    const renew = this.holdLease(run);
    try {
      const studio = await this.projects.loadStudio(
        run.projectId,
        input.actor.id,
        input.branchId,
      );
      const specs = specsOf(studio.nodes[run.nodeId] ?? null);
      if (!specs || specs.constraints?.runId !== run.id) {
        await this.runs.finish(run.id, 'Superseded');
        return;
      }
      const generated = await this.design.constraintsFor(
        input.actor,
        run.projectId,
        specs,
        input.notes,
        new AbortController().signal,
      );
      await this.projects.mutateStudio(
        run.projectId,
        input.actor.id,
        (current) => {
          const settled = settleConstraints(current, run.nodeId, run.id, null);
          if (!settled) return current;
          return applyGeneratedConstraints(settled, run.nodeId, generated)
            .project;
        },
        input.branchId,
      );
      await this.runs.finish(run.id, null);
    } catch (error) {
      this.logger.warn(
        `Constraints generation ${run.id} failed: ${describe(error)}`,
      );
      await this.failConstraints(
        run,
        input,
        error instanceof HttpException
          ? error.message
          : `Constraints generation failed: ${describe(error)}`,
      );
    } finally {
      clearInterval(renew);
    }
  }

  private async failConstraints(
    run: ClaimedRun,
    input: ConstraintsRunInput,
    message: string,
  ): Promise<void> {
    try {
      await this.projects.mutateStudio(
        run.projectId,
        null,
        (studio) =>
          settleConstraints(studio, run.nodeId, run.id, message) ?? studio,
        input.branchId,
      );
    } catch (error) {
      this.logger.error(
        `Could not mark constraints of ${run.nodeId} failed: ${describe(error)}`,
      );
    }
    try {
      await this.runs.finish(run.id, message);
    } catch (error) {
      this.logger.warn(`Could not close run ${run.id}: ${describe(error)}`);
    }
  }

  /**
   * Picks the library parts on the simulated waveforms (old frontend: right
   * after every run), keeping the user's earlier forced choices. A failure
   * keeps the default-model losses.
   */
  private async selectDevices(
    input: SimulationRunInput,
    yamlData: Record<string, unknown>,
    result: RerunResult,
  ) {
    if (!result.timeSeriesZip || !result.loss_analysis?.components.length) {
      return null;
    }
    try {
      const tj = input.junctionTemperature ?? 100.0;
      const { selection, lossAnalysis } = await this.compute.run(
        'selectDevices',
        {
          zipBase64: result.timeSeriesZip.toString('base64'),
          tj,
          deviceTypes: semiconductorTypesFromYaml(yamlData),
          preference: input.devicePreference ?? 'auto',
          overrides: input.deviceOverrides ?? null,
        },
      );
      return { selection: deviceSelectionView(selection), lossAnalysis };
    } catch (error) {
      this.logger.warn(`Device selection failed: ${describe(error)}`);
      return null;
    }
  }

  /** ngspice + result pipeline, in a worker thread. */
  private async simulate(input: RerunInput): Promise<RerunResult> {
    const { ngspicePath, timeoutSeconds } = this.settings();
    const result = await this.compute.run('rerun', {
      input,
      ngspice: { executable: ngspicePath, timeoutSeconds },
    });
    // Buffers arrive as Uint8Array after structured cloning.
    return {
      ...result,
      timeSeriesZip: result.timeSeriesZip
        ? Buffer.from(result.timeSeriesZip)
        : null,
    };
  }

  private userMessage(error: unknown): string {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return 'ngspice is not installed on the server.';
    }
    return `Simulation failed: ${describe(error)}`;
  }

  /** Stores the waveforms, then puts the result on the node. */
  private async complete(
    run: ClaimedRun,
    data: SimulationData,
    waveforms: WaveformSet,
    zip: Buffer | null,
  ): Promise<void> {
    let blobs: StoredFile[] = [];
    if (this.config.get('storage', { infer: true }).enabled) {
      blobs = await this.artifacts.store({
        projectId: run.projectId,
        nodeId: run.nodeId,
        waveforms,
        zipBase64: zip ? zip.toString('base64') : null,
      });
    } else {
      this.logger.warn(
        `S3 storage is not configured: waveforms of run ${run.id} are not kept`,
      );
    }
    const applied = await this.updateNode(
      run.projectId,
      run.nodeId,
      run.id,
      (studio, node) =>
        patchNode(studio, run.nodeId, {
          status: 'ready',
          error: null,
          data: data as unknown as Record<string, unknown>,
          rev: node.rev + 1,
        }),
    );
    if (!applied) {
      // The node was removed or re-run meanwhile: drop the orphans.
      for (const blob of blobs) {
        await this.files
          .remove(blob)
          .catch((error: unknown) =>
            this.logger.warn(
              `Could not remove orphan waveforms: ${describe(error)}`,
            ),
          );
      }
    }
  }

  private async fail(run: ClaimedRun, message: string): Promise<void> {
    try {
      await this.failNode(run.projectId, run.nodeId, run.id, message);
    } catch (error) {
      this.logger.error(
        `Could not mark simulation node ${run.nodeId} failed: ${describe(error)}`,
      );
    }
    try {
      await this.runs.finish(run.id, message);
    } catch (error) {
      // The project (and its runs) may have been deleted.
      this.logger.warn(`Could not close run ${run.id}: ${describe(error)}`);
    }
  }

  /**
   * Applies `change` while the node still belongs to this run; false when
   * it is gone or was re-run (another run id).
   */
  private async updateNode(
    projectId: string,
    nodeId: string,
    runId: string,
    change: (
      studio: StudioProject,
      node: StudioProject['nodes'][string],
    ) => StudioProject,
  ): Promise<boolean> {
    let applied = false;
    await this.projects.mutateStudio(projectId, null, (studio) => {
      const node = studio.nodes[nodeId];
      if (!node || node.data.runId !== runId) return studio;
      applied = true;
      return change(studio, node);
    });
    return applied;
  }
}
