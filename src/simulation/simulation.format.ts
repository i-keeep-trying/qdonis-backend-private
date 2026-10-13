/**
 * qdonis-core rerun payload -> Studio simulation stage data (and back for
 * stored waveforms). Pure functions.
 */

import type { DeviceSelection } from './devices.format';
import { decksSha256 } from './sizing/decks-hash';
import type { LossAnalysis as CoreLoss } from './loss/loss-engine';
import type { Dict } from './netlist/py';
import type { PlotlyFigurePayload } from './results/plotly-figures';
import type { RerunResult } from './rerun.pipeline';
import {
  DECK_KINDS,
  type DeckKind,
  type LossAnalysis,
  type Measurement,
  type MeasurementGroup,
  type SimulationData,
  type SimulationSummary,
  type WaveformPlot,
  type WaveformPlotMeta,
  type WaveformSet,
} from './simulation.types';

const rec = (v: unknown): Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dict) : {};
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : fallback;

/** Unit from the output naming convention (`vout_avg_v`, `efficiency_pct`). */
export function unitOf(name: string): string | null {
  const m = /_(v|vpp|a|w|pct|hz|s|ohm|db|deg)$/i.exec(name);
  if (!m) return null;
  const unit: Record<string, string> = {
    v: 'V',
    vpp: 'V',
    a: 'A',
    w: 'W',
    pct: '%',
    hz: 'Hz',
    s: 's',
    ohm: 'Ω',
    db: 'dB',
    deg: '°',
  };
  return unit[m[1].toLowerCase()] ?? null;
}

const valueOf = (entry: unknown): number | null => {
  if (finite(entry)) return entry;
  const v = rec(entry).value;
  return finite(v) ? v : null;
};

interface Check {
  target: string;
  status: 'pass' | 'fail';
}

/** Feasibility constraints of one analysis, by constraint id. */
function checksOf(section: Dict): Map<string, Check> {
  const checks = new Map<string, Check>();
  const constraints = rec(section.feasibility).constraints;
  if (!Array.isArray(constraints)) return checks;
  for (const raw of constraints) {
    const c = rec(raw);
    const status = c.status;
    if (status !== 'pass' && status !== 'fail') continue;
    const id = str(c.constraint_id);
    const target = c.target_value;
    checks.set(id, {
      status,
      target: finite(target) ? String(target) : str(c.description),
    });
  }
  return checks;
}

/** Requirement groups of the structured results, in analysis order. */
export function measurementGroups(results: Dict): MeasurementGroup[] {
  const groups: MeasurementGroup[] = [];
  for (const analysis of DECK_KINDS) {
    const section = rec(results[analysis]);
    const checks = checksOf(section);
    for (const [key, raw] of Object.entries(section)) {
      if (key === 'feasibility') continue;
      const req = rec(raw);
      const measurements: Measurement[] = [];
      for (const [name, entry] of Object.entries(rec(req.outputs))) {
        const value = valueOf(entry);
        if (value === null) continue;
        const check = checks.get(name) ?? checks.get(`${key}.${name}`);
        measurements.push({
          name,
          value,
          unit: unitOf(name),
          kind: 'output',
          target: check?.target ?? null,
          status: check?.status ?? 'info',
        });
      }
      for (const [name, entry] of Object.entries(rec(req.parameters))) {
        const value = valueOf(entry);
        if (value === null) continue;
        measurements.push({
          name,
          value,
          unit: unitOf(name),
          kind: 'parameter',
          target: null,
          status: 'info',
        });
      }
      if (measurements.length === 0) continue;
      groups.push({
        key,
        title: str(req.title, key),
        analysis,
        measurements,
      });
    }
  }
  return groups;
}

export function lossAnalysisView(loss: CoreLoss | null): LossAnalysis | null {
  if (!loss) return null;
  const num = (v: unknown) => (finite(v) ? v : 0);
  return {
    junctionTemperatureC: loss.assumptions.junction_temperature_c,
    defaultMosfet: loss.assumptions.default_mosfet,
    defaultDiode: loss.assumptions.default_diode,
    activeModels: loss.assumptions.plecs_model,
    components: loss.components.map((c) => ({
      component: str(c.component),
      model: str(c.model),
      deviceType: c.device_type === 'diode' ? 'diode' : 'switch',
      conductionLossW: num(c.conduction_loss_w),
      switchingLossW: num(c.switching_loss_w),
      gateDriveLossW: num(c.gate_drive_loss_w),
      leakageLossW: num(c.leakage_loss_w),
      totalLossW: num(c.total_loss_w),
      switchingEvents:
        num(c.hard_turn_on_events) +
        num(c.soft_turn_on_events) +
        num(c.turn_off_events),
    })),
  };
}

const deckKind = (v: unknown): DeckKind =>
  v === 'dc' || v === 'ac' ? v : 'transient';

/** One stored waveform from a core Plotly payload (first trace). */
export function waveformPlot(
  key: string,
  payload: PlotlyFigurePayload | Dict,
): WaveformPlot {
  const p = rec(payload);
  const trace = rec(
    Array.isArray(rec(p.figure).data)
      ? (rec(p.figure).data as unknown[])[0]
      : null,
  );
  const xs = Array.isArray(trace.x) ? (trace.x as unknown[]) : [];
  const ys = Array.isArray(trace.y) ? (trace.y as unknown[]) : [];
  const n = Math.min(xs.length, ys.length);
  return {
    key,
    signal: str(p.signal, key),
    title: str(p.title, key),
    analysis: deckKind(p.analysisType),
    quantity: p.quantity === 'current' ? 'current' : 'voltage',
    xUnit: str(p.xUnit),
    yUnit: str(p.yUnit),
    isGatePulse: p.isGatePulse === true,
    x: xs.slice(0, n).map(Number),
    y: ys.slice(0, n).map(Number),
  };
}

export function waveformSet(
  plots: Record<string, PlotlyFigurePayload | Dict>,
): WaveformSet {
  const out: WaveformSet = { plots: {} };
  for (const key of Object.keys(plots).sort()) {
    out.plots[key] = waveformPlot(key, plots[key]);
  }
  return out;
}

/**
 * Stored waveforms: the new `{ plots: WaveformSet.plots }` blob, or a legacy
 * blob holding core Plotly payloads (`figure`).
 */
export function storedWaveforms(blob: unknown): WaveformSet {
  const plots = rec(rec(blob).plots);
  const out: WaveformSet = { plots: {} };
  for (const [key, raw] of Object.entries(plots)) {
    const entry = rec(raw);
    out.plots[key] =
      'figure' in entry
        ? waveformPlot(key, entry)
        : waveformPlot(key, {
            ...entry,
            analysisType: entry.analysis,
            figure: { data: [{ x: entry.x, y: entry.y }] },
          });
  }
  return out;
}

const plotMeta = ({ x: _x, y: _y, ...meta }: WaveformPlot): WaveformPlotMeta =>
  meta;

export function summaryOf(
  analyses: DeckKind[],
  groups: MeasurementGroup[],
  plotCount: number,
  loss: LossAnalysis | null,
): SimulationSummary {
  return {
    analyses,
    measurementCount: groups.reduce((n, g) => n + g.measurements.length, 0),
    plotCount,
    // Rows are rounded to 4 decimals; so is their total.
    semiconductorLossW: loss
      ? Math.round(
          loss.components.reduce((sum, c) => sum + c.totalLossW, 0) * 1e4,
        ) / 1e4
      : null,
    lossJunctionC: loss ? loss.junctionTemperatureC : null,
    lossTemperatureSource: loss ? 'default (100 °C)' : null,
  };
}

/** Placeholder data of a queued / running simulation node. */
export function pendingSimulation(input: {
  runId: string;
  topologyId: string;
  topologyName: string;
  analyses: DeckKind[];
}): SimulationData {
  return {
    runId: input.runId,
    topologyName: input.topologyName,
    analyses: input.analyses,
    netlist: '',
    summary: summaryOf([], [], 0, null),
    measurements: [],
    lossAnalysis: null,
    plots: [],
    deviceSelection: null,
    loss_analysis: null,
    metadata: {
      topology: input.topologyId,
      analysis_type: 'all',
      num_plots: 0,
    },
    results: null,
    executedDecksSha256: null,
  };
}

/** Finished node data and the waveforms to store next to it. */
export function completedSimulation(
  pending: Pick<SimulationData, 'runId' | 'topologyName' | 'analyses'>,
  result: RerunResult,
  devices: { selection: DeviceSelection; lossAnalysis: CoreLoss } | null = null,
): { data: SimulationData; waveforms: WaveformSet } {
  const waveforms = waveformSet(result.plots);
  const groups = measurementGroups(result.results);
  // With a device selection the losses are those of the chosen parts.
  const coreLoss = devices ? devices.lossAnalysis : result.loss_analysis;
  const loss = lossAnalysisView(coreLoss);
  const plots = Object.values(waveforms.plots).map(plotMeta);
  return {
    data: {
      runId: pending.runId,
      topologyName: pending.topologyName,
      analyses: pending.analyses,
      netlist: result.netlist,
      summary: summaryOf(pending.analyses, groups, plots.length, loss),
      measurements: groups,
      lossAnalysis: loss,
      plots,
      deviceSelection: devices ? devices.selection : null,
      loss_analysis: coreLoss,
      metadata: {
        topology: result.metadata.topology,
        analysis_type: 'all',
        num_plots: result.metadata.num_plots,
      },
      results: result.results,
      executedDecksSha256: decksSha256(result.analysis_cirs),
    },
    waveforms,
  };
}
