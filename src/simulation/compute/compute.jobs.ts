/**
 * CPU-bound simulation jobs, runnable inline or in a worker thread
 * (see compute.worker.ts / ComputeService). Every job that needs files works
 * in a scratch directory that is removed before it returns.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { WaveformStats } from '../../studio-stages/circuit-data.provider';
import {
  selectDevices,
  type Overrides,
  type Preference,
  type SelectionResult,
} from '../loss/device-selection';
import {
  calculateLosses,
  lossesVsTemperature,
  type DeviceKind,
  type LossAnalysis,
  type LossTemperatureCurve,
} from '../loss/loss-engine';
import type { Dict } from '../netlist/py';
import type { NgspiceOptions } from '../ngspice/ngspice.runner';
import { readZip } from '../ngspice/zip';
import { runRerun, type RerunInput, type RerunResult } from '../rerun.pipeline';
import { waveformStats } from '../waveforms/waveform-stats';

export interface ComputeJobs {
  rerun: {
    args: { input: RerunInput; ngspice: NgspiceOptions };
    result: RerunResult;
  };
  selectDevices: {
    args: {
      zipBase64: string;
      tj: number;
      deviceTypes: Record<string, DeviceKind> | null;
      preference: Preference;
      overrides: Overrides | null;
    };
    result: { selection: SelectionResult; lossAnalysis: LossAnalysis };
  };
  losses: {
    args: {
      zipBase64: string;
      tj: number;
      componentModels: Record<string, string>;
      deviceTypes: Record<string, DeviceKind> | null;
    };
    result: LossAnalysis;
  };
  lossVsTemperature: {
    args: {
      zipBase64: string;
      componentModels: Record<string, string>;
      deviceTypes: Record<string, DeviceKind> | null;
    };
    result: LossTemperatureCurve[];
  };
  waveformStats: {
    args: { zipBase64: string; yaml: Dict | null; fsw: number | null };
    result: WaveformStats;
  };
}

export type ComputeKind = keyof ComputeJobs;

/** Extracts a time-series archive into a scratch dir for `work`, then removes it. */
async function withArchive<T>(
  zipBase64: string,
  work: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'qdonis_ts_'));
  try {
    for (const entry of readZip(Buffer.from(zipBase64, 'base64'))) {
      // Flat archive: never write outside the scratch dir.
      const name = basename(entry.name.replace(/\\/g, '/'));
      if (name && name !== '.' && name !== '..') {
        writeFileSync(join(dir, name), entry.data);
      }
    }
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runJob<K extends ComputeKind>(
  kind: K,
  args: ComputeJobs[K]['args'],
): Promise<ComputeJobs[K]['result']> {
  switch (kind) {
    case 'rerun': {
      const a = args as ComputeJobs['rerun']['args'];
      return await runRerun(a.input, a.ngspice);
    }
    case 'selectDevices': {
      const a = args as ComputeJobs['selectDevices']['args'];
      return await withArchive(a.zipBase64, (dir) => {
        const selection = selectDevices(
          dir,
          a.tj,
          a.deviceTypes,
          a.preference,
          a.overrides,
        );
        const lossAnalysis = calculateLosses(
          dir,
          a.tj,
          selection.component_models,
          a.deviceTypes,
        );
        return { selection, lossAnalysis };
      });
    }
    case 'losses': {
      const a = args as ComputeJobs['losses']['args'];
      return await withArchive(a.zipBase64, (dir) =>
        calculateLosses(dir, a.tj, a.componentModels, a.deviceTypes),
      );
    }
    case 'lossVsTemperature': {
      const a = args as ComputeJobs['lossVsTemperature']['args'];
      return await withArchive(a.zipBase64, (dir) =>
        lossesVsTemperature(dir, a.componentModels, a.deviceTypes),
      );
    }
    case 'waveformStats': {
      const a = args as ComputeJobs['waveformStats']['args'];
      return waveformStats(a.zipBase64, a.yaml, a.fsw);
    }
    default:
      throw new Error(`Unknown compute job ${String(kind)}`);
  }
}
