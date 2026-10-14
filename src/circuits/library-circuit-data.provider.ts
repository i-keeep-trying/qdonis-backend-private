import { HttpException, Injectable } from '@nestjs/common';

import { ComputeService } from '../simulation/compute/compute.service';
import { semiconductorTypesFromYaml } from '../simulation/loss/loss-engine';
import type {
  CircuitDataProvider,
  CircuitInventory,
  LossComponent,
  WaveformStats,
} from '../studio-stages/circuit-data.provider';
import { TopologiesService } from '../topologies/topologies.service';
import { branchCircuit } from '../schematic/library/stored-circuit';
import { CircuitInfoService } from './circuit-info.service';
import { applyUpdates } from './library/circuit-inventory';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Binds the studio stages' circuit seam to the migrated library: inventory,
 * waveform statistics (`/api/studio/waveform-stats`) and loss recalculation
 * (`/api/simulate/recalculate_loss`). The heavy work runs in a worker thread.
 */
@Injectable()
export class LibraryCircuitDataProvider implements CircuitDataProvider {
  constructor(
    private readonly circuits: CircuitInfoService,
    private readonly topologies: TopologiesService,
    private readonly compute: ComputeService,
  ) {}

  inventory(input: {
    topologyId: string;
    circuit?: unknown;
    recalculated?: unknown[];
  }): Promise<CircuitInventory | null> {
    try {
      const inventory = this.circuits.inventory({
        topologyId: input.topologyId,
        circuit: isObject(input.circuit) ? input.circuit : null,
        recalculated: input.recalculated ?? null,
      });
      return Promise.resolve(inventory as unknown as CircuitInventory);
    } catch (error) {
      // Unknown topology or unusable circuit: the stage reports it as missing data.
      if (error instanceof HttpException) return Promise.resolve(null);
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async waveformStats(input: {
    rawTimeSeriesZip: unknown;
    topologyId?: string;
    circuit?: unknown;
    recalculated?: unknown[];
    fsw?: number | null;
  }): Promise<WaveformStats | null> {
    if (typeof input.rawTimeSeriesZip !== 'string' || !input.rawTimeSeriesZip) {
      return null;
    }
    // Uploaded decks have no topology YAML: components are classified by ref.
    let yaml: Record<string, unknown> | null = null;
    try {
      if (isObject(input.circuit) && Array.isArray(input.circuit.components)) {
        yaml = structuredClone(input.circuit);
      } else if (input.topologyId) {
        const id = this.topologies.resolveId(input.topologyId);
        yaml = id ? this.topologies.definition(id) : null;
      }
      if (yaml) applyUpdates(yaml, input.recalculated);
    } catch {
      yaml = null;
    }
    return this.compute.run('waveformStats', {
      zipBase64: input.rawTimeSeriesZip,
      yaml,
      fsw: input.fsw || null,
    });
  }

  async recalculateLosses(input: {
    topologyId: string;
    circuit?: unknown;
    componentModels: Record<string, string>;
    rawTimeSeriesZip: unknown;
    junctionC: number;
  }): Promise<{ components: LossComponent[] } | null> {
    if (typeof input.rawTimeSeriesZip !== 'string' || !input.rawTimeSeriesZip) {
      return null;
    }
    const id = this.topologies.resolveId(input.topologyId);
    const loss = await this.compute.run('losses', {
      zipBase64: input.rawTimeSeriesZip,
      tj: input.junctionC,
      componentModels: input.componentModels,
      deviceTypes: id
        ? semiconductorTypesFromYaml(
            branchCircuit(input.circuit, this.topologies.design(id)),
          )
        : null,
    });
    return { components: loss.components as unknown as LossComponent[] };
  }
}
