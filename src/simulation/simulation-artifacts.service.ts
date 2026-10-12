import { Injectable, Logger } from '@nestjs/common';

import type { StoredFile } from '../generated/prisma/client';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import {
  heavyBlobName,
  rawSeriesBlobName,
} from '../projects/studio/studio-persistence';
import { StoredFilesService } from '../storage/stored-files.service';
import { storedWaveforms } from './simulation.format';
import type { WaveformSet } from './simulation.types';

/** Heavy outputs of one simulation node, as stored in S3. */
export interface SimulationArtifacts {
  waveforms: WaveformSet;
  /** Base64 ZIP of the sliced time series; null when it was not kept. */
  timeSeriesZip: string | null;
}

/** Memory kept for downloaded artifacts (least recently used dropped first). */
const CACHE_BYTES = 512 * 1024 * 1024;

interface Entry {
  value: WaveformSet | string | null;
  bytes: number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/**
 * The plots and the raw time series of simulation nodes. They are stored
 * apart in S3: `studio/<node>` (plots, gzipped) for the Simulation tab and
 * `studio/<node>/raw` (time-series ZIP) for devices / magnetics / thermal,
 * so each reader downloads only what it needs. Simulations stored before
 * the split keep both in `studio/<node>`.
 *
 * Downloads are cached in memory by stored-file id (a re-run gets a new
 * file, so the cache never serves stale data), and concurrent requests for
 * the same file share one download.
 */
@Injectable()
export class SimulationArtifactsService {
  private readonly logger = new Logger(SimulationArtifactsService.name);
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private cachedBytes = 0;

  constructor(private readonly files: StoredFilesService) {}

  /** Stores a finished simulation's outputs and keeps them in the cache. */
  async store(input: {
    projectId: string;
    nodeId: string;
    waveforms: WaveformSet;
    zipBase64: string | null;
  }): Promise<StoredFile[]> {
    const stored: StoredFile[] = [];
    const plots = await this.files.putStageBlob({
      projectId: input.projectId,
      actorId: null,
      name: heavyBlobName(input.nodeId),
      value: { plots: input.waveforms.plots },
      gzip: true,
    });
    stored.push(plots);
    this.remember(`${plots.id}:plots`, input.waveforms);
    if (input.zipBase64) {
      const raw = await this.files.putStageBlob({
        projectId: input.projectId,
        actorId: null,
        name: rawSeriesBlobName(input.nodeId),
        value: { raw_time_series_zip: input.zipBase64 },
      });
      stored.push(raw);
      this.remember(`${raw.id}:zip`, input.zipBase64);
    }
    return stored;
  }

  /** Stored plot samples, or none (storage off, or the node has none). */
  async waveforms(projectId: string, nodeId: string): Promise<WaveformSet> {
    this.files.assertEnabled();
    const blob = await this.files.findStageBlob(
      projectId,
      heavyBlobName(nodeId),
    );
    if (!blob) return { plots: {} };
    return this.cached(`${blob.id}:plots`, async () => {
      const value = await this.files.readStageBlob(blob);
      // A legacy combined file also carries the raw series: keep it for the engines.
      const zip = rec(value).raw_time_series_zip;
      if (typeof zip === 'string' && zip) this.remember(`${blob.id}:zip`, zip);
      return storedWaveforms(value);
    });
  }

  /**
   * A short-lived CDN (or S3) URL of the plot samples, for the browser to
   * download directly: gzipped JSON `{ plots }` in the `WaveformSet` shape.
   * Null for simulations stored before the split (their single file also
   * holds the raw series, in an older shape): those are read through
   * `waveforms()` and rewritten in the new layout in the background.
   */
  async waveformsUrl(
    projectId: string,
    nodeId: string,
  ): Promise<{ url: string; expiresAt: Date } | null> {
    this.files.assertEnabled();
    const blob = await this.files.findStageBlob(
      projectId,
      heavyBlobName(nodeId),
    );
    if (!blob) return null;
    if (blob.contentType === 'application/gzip') {
      return this.files.downloadUrl(blob);
    }
    void this.migrate(projectId, nodeId).catch((error: unknown) =>
      this.logger.warn(
        `Could not split the outputs of simulation ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return null;
  }

  /** Rewrites a combined (pre-split) outputs file as plots + raw series. */
  private async migrate(projectId: string, nodeId: string): Promise<void> {
    const key = `migrate:${projectId}:${nodeId}`;
    if (this.pending.has(key)) return;
    const job = (async () => {
      const [waveforms, zipBase64] = await Promise.all([
        this.waveforms(projectId, nodeId),
        this.timeSeriesZip(projectId, nodeId),
      ]);
      const current = await this.files.findStageBlob(
        projectId,
        heavyBlobName(nodeId),
      );
      if (!current || current.contentType === 'application/gzip') return;
      await this.store({ projectId, nodeId, waveforms, zipBase64 });
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    await job;
  }

  /** The raw time series (base64 ZIP); null when it was not kept. */
  async timeSeriesZip(
    projectId: string,
    nodeId: string,
  ): Promise<string | null> {
    if (!this.enabled()) return null;
    const raw = await this.files.findStageBlob(
      projectId,
      rawSeriesBlobName(nodeId),
    );
    // Before the split, the series lived in the plots file.
    const blob =
      raw ?? (await this.files.findStageBlob(projectId, heavyBlobName(nodeId)));
    if (!blob) return null;
    return this.cached(`${blob.id}:zip`, async () => {
      const zip = rec(await this.files.readStageBlob(blob)).raw_time_series_zip;
      return typeof zip === 'string' && zip ? zip : null;
    });
  }

  /** Both outputs; null when the node has neither (or storage is off). */
  async load(
    projectId: string,
    nodeId: string,
  ): Promise<SimulationArtifacts | null> {
    if (!this.enabled()) return null;
    const [timeSeriesZip, waveforms] = await Promise.all([
      this.timeSeriesZip(projectId, nodeId),
      this.waveforms(projectId, nodeId),
    ]);
    if (!timeSeriesZip && Object.keys(waveforms.plots).length === 0) {
      return null;
    }
    return { waveforms, timeSeriesZip };
  }

  /**
   * Adds the keys the magnetics / thermal planners read, in place on the
   * loaded (in-memory) graph of the active branch:
   * simulation `raw_time_series_zip`, `plots` (Plotly payloads, only a
   * fallback of the magnetics stage) and `device_selection`; design
   * `recalculated_parameters`.
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
    const artifacts = await this.load(projectId, sim.id).catch(
      (error: unknown) => {
        this.logger.warn(
          `Could not read the outputs of simulation ${sim.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      },
    );
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

  // --- cache ---------------------------------------------------------------------

  private async cached<T extends WaveformSet | string | null>(
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) {
      // Most recently used goes last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value as T;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const job = load()
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private remember(key: string, value: WaveformSet | string | null): void {
    const bytes =
      typeof value === 'string'
        ? value.length
        : value
          ? Object.values(value.plots).reduce(
              (sum, p) => sum + (p.x.length + p.y.length) * 8,
              0,
            )
          : 0;
    if (bytes > CACHE_BYTES) return;
    const old = this.cache.get(key);
    if (old) {
      this.cachedBytes -= old.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, { value, bytes });
    this.cachedBytes += bytes;
    for (const [k, entry] of this.cache) {
      if (this.cachedBytes <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cachedBytes -= entry.bytes;
    }
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
