/**
 * Steady-state component waveforms for the Magnetics and Thermal stages,
 * ported from qdonis-core `studio_waveforms.waveform_stats`. Reads the raw
 * (sliced) ngspice telemetry, not the decimated plot traces.
 */

import {
  MAGNETIC_TYPES,
  iterComponents,
  switchingFrequency,
  toNumber,
} from '../../circuits/library/circuit-inventory';
import type { WaveformStats } from '../../studio-stages/circuit-data.provider';
import {
  formatG,
  isDict,
  pyStr,
  roundInt,
  truthy,
  type Dict,
} from '../netlist/py';
import { readZip } from '../ngspice/zip';
import { max, min, pairwiseSum } from '../numeric/numpy';
import { readWhitespaceTable } from '../numeric/pandas-float';

const SAMPLES_PER_PERIOD = 64;
const MAX_UNIFORM_SAMPLES = 60000;
const PARAM_KEYS = [
  'resistance',
  'capacitance',
  'inductance',
  'esr',
  'series_resistance',
  'power_rating',
  'voltage_rating',
  'current_rating',
  'ripple_current_rating',
  'Lm_primary',
  'turns_ratio',
];
const PART_TYPES = new Set([
  'resistor',
  'capacitor',
  'diode',
  'transistor',
  'mosfet',
  'igbt',
  'switch',
  ...MAGNETIC_TYPES,
]);
const LINE_KEYS = [
  'frequency',
  'line_frequency',
  'grid_frequency',
  'output_frequency',
  'fundamental_frequency',
  'modulation_frequency',
];

type Pair = [number[], number[]];

// --- numpy -----------------------------------------------------------------

/** `np.interp(x, xp, fp)` (numpy's slope formula and NaN fallbacks). */
export function interp(x: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (n === 0) throw new Error('array of sample points is empty');
  if (n === 1) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  if (x < xp[0]) return fp[0];
  if (x === xp[n - 1]) return fp[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const j = lo;
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  let res = slope * (x - xp[j]) + fp[j];
  if (Number.isNaN(res)) {
    res = slope * (x - xp[j + 1]) + fp[j + 1];
    if (Number.isNaN(res) && fp[j] === fp[j + 1]) res = fp[j];
  }
  return res;
}

/** `np.trapezoid(y, x)`: pairwise sum of `d * (y[1:] + y[:-1]) / 2.0`. */
export function trapezoid(y: number[], x: number[]): number {
  const terms: number[] = [];
  for (let k = 0; k + 1 < x.length; k += 1) {
    terms.push(((x[k + 1] - x[k]) * (y[k + 1] + y[k])) / 2.0);
  }
  return pairwiseSum(terms);
}

/** `np.gradient(f, x)` with edge_order=1. */
export function gradient(f: number[], x: number[]): number[] {
  const n = f.length;
  if (n < 2) {
    throw new Error(
      'Shape of array too small to calculate a numerical gradient, at least (edge_order + 1) elements are required.',
    );
  }
  const dx: number[] = [];
  for (let k = 0; k + 1 < n; k += 1) dx.push(x[k + 1] - x[k]);
  const out = new Array<number>(n);
  const uniform = dx.every((d) => d === dx[0]);
  for (let k = 1; k < n - 1; k += 1) {
    if (uniform) out[k] = (f[k + 1] - f[k - 1]) / (2.0 * dx[0]);
    else {
      const dx1 = dx[k - 1];
      const dx2 = dx[k];
      const a = -dx2 / (dx1 * (dx1 + dx2));
      const b = (dx2 - dx1) / (dx1 * dx2);
      const c = dx1 / (dx2 * (dx1 + dx2));
      out[k] = a * f[k - 1] + b * f[k] + c * f[k + 1];
    }
  }
  out[0] = (f[1] - f[0]) / dx[0];
  out[n - 1] = (f[n - 1] - f[n - 2]) / dx[n - 2];
  return out;
}

// --- helpers ------------------------------------------------------------------

function lineFrequency(yaml: Dict): number | null {
  let best: number | null = null;
  for (const [comp] of iterComponents(yaml.components)) {
    const params = isDict(comp.params) ? comp.params : {};
    for (const key of LINE_KEYS) {
      const value = toNumber(params[key]);
      if (value && value >= 1.0 && value < 1e3) {
        best = best === null ? value : Math.min(best, value);
      }
    }
  }
  return best;
}

const typeFromRef = (ref: string): string | null =>
  ({
    R: 'resistor',
    C: 'capacitor',
    L: 'inductor',
    T: 'transformer',
    D: 'diode',
  })[ref.slice(0, 1).toUpperCase()] ?? null;

/** `_read_series`: finite samples below 1e6, strictly increasing time. */
function readSeries(text: string): Pair {
  const columns = readWhitespaceTable(text);
  if (columns.length < 2) throw new Error('KeyError: 1');
  const [t0, y0] = columns;
  const t: number[] = [];
  const y: number[] = [];
  for (let k = 0; k < t0.length; k += 1) {
    if (
      Number.isFinite(t0[k]) &&
      Number.isFinite(y0[k]) &&
      Math.abs(y0[k]) < 1e6
    ) {
      t.push(t0[k]);
      y.push(y0[k]);
    }
  }
  const ts: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < t.length; k += 1) {
    if (k === 0 || t[k] - t[k - 1] > 0) {
      ts.push(t[k]);
      ys.push(y[k]);
    }
  }
  return [ts, ys];
}

/** `_collect`: {ref: {V, I, I_pri, I_sec}} from the archive's CSV names. */
function collect(files: Map<string, string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const put = (ref: string, key: string, name: string) => {
    const group = out.get(ref) ?? new Map<string, string>();
    group.set(key, name);
    out.set(ref, group);
  };
  for (const path of files.keys()) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const stem = name.slice(0, -4);
    if (stem.startsWith('V_')) put(stem.slice(2), 'V', path);
    else if (stem.startsWith('I_')) {
      const ref = stem.slice(2);
      if (ref.endsWith('_pri')) put(ref.slice(0, -4), 'I_pri', path);
      else if (ref.endsWith('_sec')) put(ref.slice(0, -4), 'I_sec', path);
      else put(ref, 'I', path);
    }
  }
  return out;
}

function segment(t: number[], y: number[], t0: number, t1: number): Pair {
  const ts = [t0];
  const ys = [interp(t0, t, y)];
  for (let k = 0; k < t.length; k += 1) {
    if (t[k] > t0 && t[k] < t1) {
      ts.push(t[k]);
      ys.push(y[k]);
    }
  }
  ts.push(t1);
  ys.push(interp(t1, t, y));
  return [ts, ys];
}

function stats(t: number[], y: number[], t0: number, t1: number) {
  const [ts, ys] = segment(t, y, t0, t1);
  const span = t1 - t0;
  const avg = trapezoid(ys, ts) / span;
  const ms =
    trapezoid(
      ys.map((v) => v * v),
      ts,
    ) / span;
  const hi = max(ys);
  const lo = min(ys);
  return {
    avg,
    rms: Math.sqrt(Math.max(ms, 0.0)),
    ac_rms: Math.sqrt(Math.max(ms - avg * avg, 0.0)),
    peak: max(ys.map(Math.abs)),
    max: hi,
    min: lo,
    pp: hi - lo,
  };
}

/** `float(f"{v:.5g}")` for every value. */
const round5 = (values: number[]): number[] =>
  values.map((v) => Number(formatG(v, 5)));

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// --- main ---------------------------------------------------------------------

/** `waveform_stats(raw_zip_b64, yaml_dict, fsw)`. */
export function waveformStats(
  rawZipBase64: string,
  yamlDict: Dict | null,
  fswIn: number | null = null,
): WaveformStats {
  const yaml = yamlDict ?? {};
  const fsw = fswIn || switchingFrequency(yaml);
  const fLine = lineFrequency(yaml);

  const meta = new Map<string, Dict>();
  for (const [comp, parent] of iterComponents(yaml.components)) {
    const ref = comp.ref;
    if (ref === undefined || ref === null || ref === '' || ref === 0) continue;
    const params = isDict(comp.params) ? comp.params : {};
    const values: Record<string, number> = {};
    for (const key of PARAM_KEYS) {
      const value = toNumber(params[key]);
      if (value !== null) values[key] = value;
    }
    const entry: Dict = {
      type: comp.type ?? null,
      role: comp.role ?? null,
      parent: parent ?? null,
      params: values,
    };
    if (truthy(parent)) {
      // Nested parts (RC snubbers…) connect by [ref, pin]; the Thermal stage uses
      // these to find the snubber's own capacitor and the winding it sits across.
      const connections = isDict(comp.connections) ? comp.connections : {};
      const links = Object.values(connections)
        .filter((c): c is unknown[] => Array.isArray(c) && c.length === 2)
        .map((c) => [pyStr(c[0]), pyStr(c[1])]);
      if (links.length) entry.links = links;
    }
    meta.set(pyStr(ref), entry);
  }

  const archive = new Map<string, string>();
  for (const entry of readZip(Buffer.from(rawZipBase64, 'base64'))) {
    archive.set(entry.name, entry.data.toString('latin1'));
  }
  const series = new Map<string, Map<string, Pair>>();
  for (const [ref, group] of collect(archive)) {
    const read = new Map<string, Pair>();
    for (const [key, path] of group)
      read.set(key, readSeries(archive.get(path)!));
    series.set(ref, read);
  }

  let tFirst: number | null = null;
  let tEnd: number | null = null;
  for (const group of series.values()) {
    for (const [t] of group.values()) {
      if (t.length > 1) {
        tFirst = tFirst === null ? t[0] : Math.min(tFirst, t[0]);
        tEnd =
          tEnd === null ? t[t.length - 1] : Math.max(tEnd, t[t.length - 1]);
      }
    }
  }
  if (tEnd === null || tFirst === null) {
    throw new Error('The simulation has no component telemetry to analyse.');
  }
  const duration = tEnd - tFirst;

  let span: number;
  let basis: string;
  if (fLine && duration >= 0.75 / fLine) {
    span = 0.5 / fLine;
    basis = 'half line cycle';
  } else if (fsw) {
    const periods = Math.trunc(
      Math.max(1, Math.min(20, Math.floor(0.3 * duration * fsw))),
    );
    span = periods / fsw;
    basis = `${periods} switching period${periods > 1 ? 's' : ''}`;
  } else {
    span = 0.25 * duration;
    basis = 'last 25 % of the run';
  }
  span = Math.min(span, duration);
  let spp: number | null = null;
  let nUniform: number;
  if (fsw) {
    const periods = Math.max(1, Number(roundInt(span * fsw)));
    if (periods / fsw <= duration) span = periods / fsw;
    spp = Math.max(
      16,
      Math.min(SAMPLES_PER_PERIOD, Math.floor(MAX_UNIFORM_SAMPLES / periods)),
    );
    nUniform = periods * spp;
  } else {
    nUniform = 4096;
  }
  const t0 = tEnd - span;
  const dt = span / nUniform;
  const grid: number[] = [];
  for (let k = 0; k < nUniform; k += 1) grid.push(t0 + (k + 0.5) * dt);

  const components: Record<string, Dict> = {};
  const refs = [...new Set([...meta.keys(), ...series.keys()])].sort(codeUnit);
  for (const ref of refs) {
    const info: Dict = {
      ...(meta.get(ref) ?? {
        type: typeFromRef(ref),
        role: null,
        parent: null,
        params: {},
      }),
    };
    let group = series.get(ref) ?? new Map<string, Pair>();
    try {
      const v = group.get('V');
      if (v) info.v = stats(v[0], v[1], t0, tEnd);
      const capacitance = (info.params as Record<string, number>).capacitance;
      if (v && !group.has('I') && info.type === 'capacitor' && capacitance) {
        const dvdt = gradient(v[1], v[0]);
        group = new Map(group);
        group.set('I', [v[0], dvdt.map((d) => capacitance * d)]);
        info.i_derived = true;
      }
      const currentKey = group.has('I')
        ? 'I'
        : group.has('I_pri')
          ? 'I_pri'
          : null;
      if (currentKey) {
        const [ti, yi] = group.get(currentKey)!;
        info.i = stats(ti, yi, t0, tEnd);
      }
      const pri = group.get('I_pri');
      if (pri) info.i_pri = stats(pri[0], pri[1], t0, tEnd);
      const sec = group.get('I_sec');
      if (sec) info.i_sec = stats(sec[0], sec[1], t0, tEnd);
      if (v && currentKey) {
        const [ti, yi] = group.get(currentKey)!;
        const [ts, iv] = segment(ti, yi, t0, tEnd);
        const p = ts.map((x, k) => interp(x, v[0], v[1]) * iv[k]);
        info.p_avg = trapezoid(p, ts) / span;
      }
      const type = info.type;
      const isMagnetic =
        (typeof type === 'string' && MAGNETIC_TYPES.has(type)) ||
        (!type &&
          (ref.toUpperCase().startsWith('L') ||
            ref.toUpperCase().startsWith('T')));
      if (isMagnetic && v && currentKey) {
        const at = ([xs, ys]: Pair) =>
          round5(grid.map((g) => interp(g, xs, ys)));
        const wave: Record<string, number[]> = {
          v: at(v),
          i: at(group.get(currentKey)!),
        };
        if (pri) wave.i_pri = at(pri);
        if (sec) wave.i_sec = at(sec);
        info.wave = wave;
      }
    } catch (error) {
      info.error = errorText(error);
    }
    if (
      group.size > 0 ||
      (typeof info.type === 'string' && PART_TYPES.has(info.type))
    ) {
      components[ref] = info;
    }
  }

  return {
    fsw: fsw || null,
    line_frequency: fLine,
    window: { start: t0, span, basis, duration },
    dt,
    samples_per_period: spp,
    components: components as unknown as WaveformStats['components'],
  };
}
