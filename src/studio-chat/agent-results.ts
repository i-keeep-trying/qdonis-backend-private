import { specsSignature, type SpecsData } from '../design/studio-specs.logic';
import type { JsonObject } from '../projects/studio/studio-graph';
import type {
  DesignData,
  LossComponent,
  RecalculatedParameter,
} from '../simulation/simulation.types';

/**
 * What the Studio agent is told about stage results (ports of the old
 * frontend `designPayload`, `summarizeSimulation`, `describeSelection` and
 * the snapshot helpers in `lib/studio/store.ts`), read from the stage data
 * as the backend stores it.
 */

export const rec = (v: unknown): JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as JsonObject)
    : {};
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const records = (v: unknown): JsonObject[] =>
  list(v).filter(
    (x): x is JsonObject =>
      typeof x === 'object' && x !== null && !Array.isArray(x),
  );
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A model-facing scalar as text ('' for anything else). */
export const scalar = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';

/** `L1 (inductor, output filter)` for a circuit inventory entry. */
export const componentLine = (c: JsonObject): string => {
  const role = scalar(c.role);
  return `${scalar(c.ref)} (${scalar(c.type)}${role ? `, ${role}` : ''})`;
};

export const clip = (text: unknown, n: number): string => {
  const str =
    typeof text === 'string'
      ? text
      : text === null || text === undefined
        ? ''
        : JSON.stringify(text);
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

/** Design-table parameters that are template internals, not component values. */
const HIDDEN = new Set([
  'spice_line',
  'expression',
  'ic',
  'part_number',
  'cost',
  'technology',
  'tr',
  'tf',
  'rds_on',
  'vto',
  'kn',
  'lambda',
  'cgs',
  'cgd',
  'cdb',
  'is',
  'n',
  'rs',
  'cjo',
  'tt',
  'ibv',
  'family',
  'mode',
  'type',
  'node_type',
  'source',
  'polarized',
  'tolerance',
  'temp_coefficient',
  'leakage_current',
  'esl',
  'parasitic_inductance',
  'parasitic_capacitance',
  'core_loss_resistance',
  'sense',
  'ramp_rise',
  'trise',
  'tfall',
  'vhigh',
  'vlow',
  'drive_resistance',
  'name',
  'phase',
  'model',
  'description',
  'qg',
  'vf',
]);

export function isMeaningfulParam(p: { ref?: unknown; param?: unknown }) {
  const ref = typeof p.ref === 'string' ? p.ref : '';
  const key = (typeof p.param === 'string' ? p.param : '').toLowerCase();
  return !!ref && !/^COMMENT/i.test(ref) && !HIDDEN.has(key);
}

const rowsOf = (data: JsonObject): RecalculatedParameter[] =>
  records(data.recalculatedParameters) as unknown as RecalculatedParameter[];

export function designPayload(
  data: JsonObject,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const design = data as unknown as Partial<DesignData>;
  return {
    topology_id: design.topologyId,
    decks: Object.keys(rec(design.decks)),
    parameters: rowsOf(data)
      .filter(isMeaningfulParam)
      .slice(0, 60)
      .map((p) => ({ ref: p.ref, param: p.param, value: p.after })),
    note: 'Switches and diodes are NOT chosen yet: they are picked from the device library after the simulation (select_devices). Do not name device parts or technology before that.',
    quick_params: design.quickParamsLine || undefined,
    reasoning_excerpt: design.reasoning
      ? String(design.reasoning).slice(0, 1500)
      : undefined,
    ...extra,
  };
}

/** Design-table lines for the snapshot. */
export function designParameterLines(data: JsonObject, max = 60): string[] {
  return rowsOf(data)
    .filter(isMeaningfulParam)
    .slice(0, max)
    .map((p) => `${p.ref}.${p.param} = ${p.after}`);
}

/** Changed design values (another branch's summary). */
export function changedParameterLines(data: JsonObject, max = 20): string[] {
  return rowsOf(data)
    .filter((p) => p.before !== '' && String(p.before) !== String(p.after))
    .slice(0, max)
    .map((p) => `${p.ref}.${p.param} = ${p.after}`);
}

function readMeasurement(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value) {
    const v = (value as JsonObject).value;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    const shown = Number.isFinite(n)
      ? Number(n.toPrecision(5)).toString()
      : String(v);
    const description = (value as JsonObject).description;
    return description ? `${shown} (${clip(description, 60)})` : shown;
  }
  if (typeof value === 'number') return Number(value.toPrecision(5)).toString();
  return clip(value, 80);
}

const lossesOf = (data: JsonObject): LossComponent[] =>
  records(rec(data.lossAnalysis).components) as unknown as LossComponent[];

/** Simulation results as "analysis | requirement | name = value" lines plus the losses. */
export function summarizeSimulation(
  data: JsonObject,
  maxLines = 60,
): Record<string, unknown> {
  const lines: string[] = [];
  const results = rec(data.results);
  for (const analysis of ['dc', 'ac', 'transient']) {
    for (const [reqKey, req] of Object.entries(rec(results[analysis]))) {
      const block = rec(req);
      const title = typeof block.title === 'string' ? block.title : reqKey;
      for (const group of ['outputs', 'parameters']) {
        for (const [name, value] of Object.entries(rec(block[group]))) {
          if (lines.length < maxLines) {
            lines.push(
              `${analysis} | ${clip(title, 50)} | ${name} = ${readMeasurement(value)}`,
            );
          }
        }
      }
    }
  }
  const components = lossesOf(data);
  const losses = components.slice(0, 12).map((c) => ({
    component: c.component,
    total_w: c.totalLossW,
    conduction_w: c.conductionLossW,
    switching_w: c.switchingLossW,
  }));
  const total = components.reduce((acc, c) => acc + (c.totalLossW || 0), 0);
  return {
    measurements: lines,
    plots: list(data.plots).length,
    semiconductor_losses: losses,
    total_semiconductor_loss_w: losses.length
      ? Number(total.toFixed(3))
      : undefined,
  };
}

interface SelectionView {
  selections: Array<{
    ref: string;
    stress: { vPeakV: number; iPeakA: number; iRmsA: number; fswKhz: number };
    selected: null | {
      part: string;
      family: string;
      vRatingV: number;
      diode: string | null;
      lossW: number;
    };
    reason: string | null;
    alternatives: Array<{ part: string; lossW: number }>;
  }>;
  junctionC: number;
}

const selectionOf = (value: unknown): SelectionView | null =>
  Array.isArray(rec(value).selections) ? (value as SelectionView) : null;

/** Each chosen device for the model (old `describeSelection`). */
export function describeSelection(
  value: unknown,
): Array<Record<string, unknown>> {
  const sel = selectionOf(value);
  if (!sel) return [];
  return sel.selections.map((d) => ({
    ref: d.ref,
    device: d.selected
      ? `${d.selected.part}${d.selected.diode ? ` + ${d.selected.diode}` : ''}`
      : 'none suitable',
    family: d.selected?.family,
    rating: d.selected ? `${d.selected.vRatingV} V` : undefined,
    stress: `Vpk ${d.stress.vPeakV.toFixed(0)} V, Ipk ${d.stress.iPeakA.toFixed(2)} A, Irms ${d.stress.iRmsA.toFixed(2)} A${d.stress.fswKhz >= 1 ? `, ${d.stress.fswKhz.toFixed(1)} kHz` : ''}`,
    loss_w: d.selected?.lossW,
    why: d.reason ?? undefined,
    alternatives: d.alternatives
      .slice(0, 3)
      .map((a) => `${a.part} (${a.lossW} W)`),
  }));
}

/** One line per chosen device, for the snapshot. */
export function selectionLines(value: unknown): string[] | null {
  const sel = selectionOf(value);
  if (!sel) return null;
  return sel.selections.map((d) =>
    d.selected
      ? `${d.ref}: ${d.selected.part}${d.selected.diode ? ` + ${d.selected.diode}` : ''} (${d.selected.family}, ${d.selected.vRatingV} V) loss ${d.selected.lossW} W`
      : `${d.ref}: no suitable part`,
  );
}

export const selectionJunctionC = (value: unknown): number | null =>
  num(rec(value).junctionC);

/** Losses of a Devices-stage result for the model. */
export function deviceLosses(data: JsonObject) {
  const components = records(data.losses) as unknown as LossComponent[];
  const total = components.reduce((a, c) => a + (c.totalLossW || 0), 0);
  return {
    losses: components.map((c) => ({
      ref: c.component,
      conduction_w: c.conductionLossW,
      switching_w: c.switchingLossW,
      gate_drive_w: c.gateDriveLossW,
      total_w: c.totalLossW,
    })),
    total_semiconductor_loss_w: Number(total.toFixed(3)),
  };
}

/** The constraints list for the snapshot (bounded to ~3.5k characters). */
export function constraintsSnapshot(specs: SpecsData) {
  const c = specs.constraints;
  if (!c) return null;
  if (c.status === 'running') return { status: 'generating' };
  if (c.status === 'error' && !c.items.length) {
    return { status: 'failed', error: c.error };
  }
  let budget = 3500;
  const items: string[] = [];
  for (const i of c.items) {
    const line = `[${i.category}] ${i.name}: ${i.value || 'unspecified'}${i.source === 'user' ? ' (set by user)' : ''}`;
    budget -= line.length;
    if (budget < 0) break;
    items.push(line);
  }
  return {
    total: c.items.length,
    stale: c.basis !== specsSignature(specs.rows),
    items,
    ...(items.length < c.items.length
      ? { omitted: c.items.length - items.length }
      : {}),
  };
}

/** Constraints list summary returned by generate_constraints (old `constraintsPayload`). */
export function constraintsPayload(specs: SpecsData): Record<string, unknown> {
  const items = specs.constraints?.items ?? [];
  const byCategory: Record<string, string[]> = {};
  for (const c of items) {
    (byCategory[c.category] ||= []).push(
      `${c.name}: ${c.value || 'unspecified'}`,
    );
  }
  return {
    total: items.length,
    by_category: byCategory,
    assumptions: (specs.constraints?.assumptions ?? []).slice(0, 12),
    citations: specs.constraints?.citations.length ?? 0,
  };
}
