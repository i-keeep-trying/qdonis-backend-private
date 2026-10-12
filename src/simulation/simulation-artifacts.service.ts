import { Injectable } from '@nestjs/common';

import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { heavyBlobName } from '../projects/studio/studio-persistence';
import { StoredFilesService } from '../storage/stored-files.service';
import { storedWaveforms } from './simulation.format';
import type { WaveformSet } from './simulation.types';

/** Heavy outputs of one simulation node, as stored in S3 (`studio/<nodeId>`). */
export interface SimulationArtifacts {
  waveforms: WaveformSet;
  /** Base64 ZIP of the sliced time series; null when it was not kept. */
  timeSeriesZip: string | null;
}

/**
 * Reads the waveforms and raw time series of simulation nodes back from S3,
 * and hands them to the stage planners in the shape qdonis-core produced.
 */
@Injectable()
export class SimulationArtifactsService {
  constructor(private readonly files: StoredFilesService) {}

  /** Null when the node has no stored outputs (or storage is off). */
  async load(
    projectId: string,
    nodeId: string,
  ): Promise<SimulationArtifacts | null> {
    if (!this.enabled()) return null;
    const blob = await this.files.findStageBlob(
      projectId,
      heavyBlobName(nodeId),
    );
    if (!blob) return null;
    const value = JSON.parse(
      (await this.files.read(blob)).toString('utf8'),
    ) as unknown;
    const zip =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).raw_time_series_zip
        : null;
    return {
      waveforms: storedWaveforms(value),
      timeSeriesZip: typeof zip === 'string' && zip ? zip : null,
    };
  }

  /** Stored waveforms, or none (storage off, or the node has none). */
  async waveforms(projectId: string, nodeId: string): Promise<WaveformSet> {
    this.files.assertEnabled();
    return (await this.load(projectId, nodeId))?.waveforms ?? { plots: {} };
  }

  /**
   * Adds the keys the magnetics / thermal planners read, in place on the
   * loaded (in-memory) graph of the active branch:
   * simulation `raw_time_series_zip`, `plots` (Plotly payloads) and
   * `device_selection`; design `recalculated_parameters`.
   */
  async hydrate(projectId: string, studio: StudioProject): Promise<void> {
    const design = stageNodeOnBranch(studio, 'design');
    if (design && Array.isArray(design.data.recalculatedParameters)) {
      studio.nodes[design.id] = {
        ...design,
        data: {
          ...design.data,
          recalculated_parameters: design.data.recalculatedParameters,
        },
      };
    }
    const sim = stageNodeOnBranch(studio, 'simulation');
    if (!sim || sim.status !== 'ready') return;
    const data = { ...sim.data };
    if (data.deviceSelection && !data.device_selection) {
      data.device_selection = data.deviceSelection;
    }
    const artifacts = await this.load(projectId, sim.id).catch(() => null);
    if (artifacts) {
      data.raw_time_series_zip = artifacts.timeSeriesZip;
      data.plots = Object.fromEntries(
        Object.entries(artifacts.waveforms.plots).map(([key, p]) => [
          key,
          {
            signal: p.signal,
            xUnit: p.xUnit,
            yUnit: p.yUnit,
            figure: { data: [{ x: p.x, y: p.y }] },
          },
        ]),
      );
    } else {
      delete data.plots; // the plot index is not a Plotly payload
    }
    studio.nodes[sim.id] = { ...sim, data };
  }

  private enabled(): boolean {
    try {
      this.files.assertEnabled();
      return true;
    } catch {
      return false;
    }
  }
}
