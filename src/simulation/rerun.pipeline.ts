/**
 * Stateless edited-deck re-run, ported from qdonis-core
 * `api_server._run_rerun_simulation` (the `/api/simulate/rerun` worker).
 *
 * Everything happens in a scratch directory that is removed before returning;
 * the time-series bundle is returned as a ZIP buffer for the caller to store.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calculateLosses,
  semiconductorTypesFromYaml,
} from './loss/loss-engine';
import type { DeviceKind, LossAnalysis } from './loss/loss-engine';
import { globOrder, sliceSteadyState } from './loss/time-series';
import { applyDesignSummary } from './netlist/design-summary';
import { isDict, toFloat, truthy, type Dict } from './netlist/py';
import {
  DECK_FILES,
  runAnalyses,
  sanitizeEditedDeck,
  type AnalysisKind,
  type NgspiceOptions,
} from './ngspice/ngspice.runner';
import { createZip } from './ngspice/zip';
import { parseMeasurements } from './results/measurements';
import { generatePlotlyFigures } from './results/plotly-figures';
import type { PlotlyFigurePayload } from './results/plotly-figures';
import {
  embedFeasibility,
  structureSimulationResults,
} from './results/structure';

const LOSS_WINDOW_MS = 20.0;
const DEFAULT_RERUN_TJ = 100.0;

export interface RerunInput {
  topologyId: string;
  /** Parsed topology YAML (Python-typed: ints as bigint). */
  yamlData: unknown;
  /** Edited decks keyed by analysis (`dc` / `ac` / `transient`). */
  analysisCirs: Record<string, string | null>;
  componentModels?: unknown;
  junctionTemperature?: unknown;
}

export interface RerunResult {
  success: true;
  plotsResolution: 'full';
  results: Dict;
  plots: Record<string, PlotlyFigurePayload>;
  netlist: string;
  analysis_cirs: Partial<Record<AnalysisKind, string>>;
  loss_analysis: LossAnalysis | null;
  metadata: {
    topology: string;
    analysis_type: 'all';
    num_plots: number;
    has_netlist: boolean;
    rerun_from_edited_netlist: true;
  };
  /** `time_series/` after slicing, zipped (core: `raw_time_series_zip`). */
  timeSeriesZip: Buffer | null;
  /** Sliced time-series file contents by name (for storage / parity checks). */
  timeSeries: Record<string, Buffer>;
}

/** `_split_netlist_and_tail`: netlist portion before the first `.end` / `.control`. */
export function splitNetlistAndTail(text: string): [string, string] {
  if (!text) return ['', ''];
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const s = lines[idx].trim().toLowerCase();
    if (s === '.end' || s.startsWith('.control')) {
      return [lines.slice(0, idx).join('\n'), lines.slice(idx).join('\n')];
    }
  }
  return [text, ''];
}

const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** Python `str.rstrip("\n")`. */
const rstripNewlines = (text: string): string => text.replace(/\n+$/, '');

function readNormalized(path: string): string {
  return existsSync(path) ? normalizeNewlines(readFileSync(path, 'utf8')) : '';
}

/** Junction temperature: `float(value)` when it parses, else 100 °C. */
function junctionTemperature(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_RERUN_TJ;
  try {
    return toFloat(value);
  } catch {
    return DEFAULT_RERUN_TJ;
  }
}

function lossAnalysis(
  dir: string,
  input: RerunInput,
  deviceTypes: Record<string, DeviceKind>,
): LossAnalysis | null {
  const models = input.componentModels;
  // core: `.items()` on a truthy non-dict raised and the loss step was skipped
  if (truthy(models) && !isDict(models)) return null;
  try {
    return calculateLosses(
      dir,
      junctionTemperature(input.junctionTemperature),
      isDict(models) ? models : null,
      deviceTypes,
    );
  } catch {
    return null;
  }
}

/**
 * The template YAML carries the template's targets and component values.
 * Decks produced by the design embed the designed ones (`* qdonis-design:`);
 * applied to a copy so result formulas (regulation error, output power, ...)
 * use the design that was simulated.
 */
function designedYaml(input: RerunInput): unknown {
  if (!isDict(input.yamlData)) return input.yamlData;
  const design = structuredClone(input.yamlData);
  return applyDesignSummary(design, Object.values(input.analysisCirs))
    ? design
    : input.yamlData;
}

export async function runRerun(
  input: RerunInput,
  ngspice: NgspiceOptions,
): Promise<RerunResult> {
  const outputDir = mkdtempSync(join(tmpdir(), 'qdonis_rerun_'));
  try {
    const timeSeriesDir = join(outputDir, 'time_series');
    mkdirSync(join(outputDir, 'plots'), { recursive: true });
    mkdirSync(timeSeriesDir, { recursive: true });

    for (const [key, content] of Object.entries(input.analysisCirs)) {
      const file = DECK_FILES[key.toLowerCase() as AnalysisKind];
      if (file !== undefined && content !== null && content !== undefined) {
        writeFileSync(
          join(outputDir, file),
          sanitizeEditedDeck(content),
          'utf8',
        );
      }
    }

    const analysisFilter = Object.keys(input.analysisCirs);
    const logs = await runAnalyses(outputDir, analysisFilter, ngspice);
    const measurements = new Map<string, number>();
    for (const log of logs) {
      for (const [name, value] of parseMeasurements(log)) {
        measurements.set(name, value);
      }
    }

    const yamlData = designedYaml(input);
    const env = {
      outputDir: logs.length ? outputDir : null,
      yamlData,
    };
    const filter = analysisFilter.length ? analysisFilter : null;
    const results = structureSimulationResults(
      measurements,
      yamlData,
      filter,
      env,
    );
    embedFeasibility(results, yamlData, filter, env);
    const plots = generatePlotlyFigures(outputDir, yamlData);

    const analysisCirs: Partial<Record<AnalysisKind, string>> = {};
    for (const kind of ['dc', 'ac', 'transient'] as const) {
      const text = readNormalized(join(outputDir, DECK_FILES[kind]));
      if (text) analysisCirs[kind] = text;
    }

    let netlist = '';
    for (const kind of ['dc', 'transient', 'ac'] as const) {
      const deck = analysisCirs[kind];
      if (!deck) continue;
      const [part] = splitNetlistAndTail(deck);
      if (part.trim()) {
        netlist = `${rstripNewlines(part)}\n.end\n`;
        break;
      }
    }

    let loss: LossAnalysis | null = null;
    if (readdirSync(timeSeriesDir).length) {
      const deviceTypes = semiconductorTypesFromYaml(yamlData);
      const keepRefs = Object.entries(deviceTypes)
        .filter(([, kind]) => kind)
        .map(([ref]) => ref);
      try {
        sliceSteadyState(timeSeriesDir, LOSS_WINDOW_MS, keepRefs);
      } catch {
        // core logged the slicing failure and continued
      }
      loss = lossAnalysis(timeSeriesDir, input, deviceTypes);
    }

    const timeSeries: Record<string, Buffer> = {};
    for (const name of globOrder(readdirSync(timeSeriesDir))) {
      timeSeries[name] = readFileSync(join(timeSeriesDir, name));
    }
    const names = Object.keys(timeSeries);

    return {
      success: true,
      plotsResolution: 'full',
      results,
      plots,
      netlist,
      analysis_cirs: analysisCirs,
      loss_analysis: loss,
      metadata: {
        topology: input.topologyId,
        analysis_type: 'all',
        num_plots: Object.keys(plots).length,
        has_netlist: netlist.length > 0,
        rerun_from_edited_netlist: true,
      },
      timeSeriesZip: createZip(
        names.map((name) => ({ name, data: timeSeries[name] })),
      ),
      timeSeries,
    };
  } finally {
    // Scratch only: a cleanup failure (a file still locked on Windows) must not
    // replace the run's own result or error.
    try {
      rmSync(outputDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      // left for the OS temp cleanup
    }
  }
}
