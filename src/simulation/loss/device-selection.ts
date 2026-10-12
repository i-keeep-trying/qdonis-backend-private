/**
 * Semiconductor selection from the device model library, ported from
 * qdonis-core `simulator/device_selection.py`: shortlist library parts by
 * voltage class and current fit, evaluate each with the loss engine on the
 * device's waveforms and pick the lowest loss (lightly penalising
 * over-sizing).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  currentFromPart,
  partFamily,
  voltageFromPart,
} from '../../devices/library/part-ratings';
import { formatFixed, isDict, pyStr, toFloat, type Dict } from '../netlist/py';
import { max, mean, pyRound, pySum } from '../numeric/numpy';
import {
  LIBRARY_DIR,
  classifyRef,
  collectComponentSeries,
  componentLosses,
  loadModel,
  readComponentSeries,
  type DeviceKind,
} from './loss-engine';

const VOLTAGE_DERATING = 1.3;
const CURRENT_MARGIN = 1.5;
const MAX_CANDIDATES = 18;
const OVERSIZE_LIMIT = 25;
const GATE_THRESHOLD = 2.5;

export type Preference = 'auto' | 'mosfet' | 'igbt';
type Kind = 'switch' | 'diode';
type Series = [number[], number[], number[], number[] | null];

export interface CataloguePart {
  part: string;
  type: string;
  kind: Kind;
  family: string;
  v_rating: number;
  i_rating: number;
  i_lut: number;
}

export interface Stress {
  v_peak: number;
  i_peak: number;
  i_rms: number;
  i_avg: number;
  fsw: number;
}

interface Device {
  kind: Kind;
  series: Series;
  stress: Stress;
}

// ---------------------------------------------------------------------------
// Library catalogue
// ---------------------------------------------------------------------------

/**
 * `Path.rglob('*.json')` order on Python 3.13: each directory's entries in
 * listing order (files of a directory before its subdirectories' files),
 * subdirectories walked depth first.
 */
function rglobJson(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    const names = readdirSync(current).sort((a, b) => {
      const ua = a.toUpperCase();
      const ub = b.toUpperCase();
      return ua < ub ? -1 : ua > ub ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    const subdirs: string[] = [];
    for (const name of names) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) subdirs.push(path);
      else if (name.endsWith('.json')) out.push(path);
    }
    for (const sub of subdirs) walk(sub);
  };
  walk(dir);
  return out;
}

const numberOr0 = (value: unknown): number => {
  if (value === null || value === undefined || value === false) return 0;
  try {
    return toFloat(value) || 0;
  } catch {
    return 0;
  }
};

let catalogueCache: CataloguePart[] | null = null;

/** Usable models with parsed ratings (no diode-less MOSFETs, no body diodes). */
export function catalogue(): CataloguePart[] {
  if (catalogueCache) return catalogueCache;
  const parts: CataloguePart[] = [];
  for (const path of rglobJson(LIBRARY_DIR)) {
    const file = path.slice(
      Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
    );
    const stem = file.slice(0, -'.json'.length);
    if (stem.toLowerCase().endsWith('_bodydiode')) continue;
    let meta: Dict;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      meta = isDict(doc) && isDict(doc.metadata) ? doc.metadata : {};
    } catch {
      continue;
    }
    const type = typeof meta.type === 'string' ? meta.type : '';
    if (!['MOSFET with Diode', 'IGBT', 'Diode'].includes(type)) continue;
    const iLut = numberOr0(meta.current_rating_A);
    const iRating = currentFromPart(stem) || iLut;
    parts.push({
      part: stem,
      type,
      kind: type === 'Diode' ? 'diode' : 'switch',
      family: partFamily(stem, type),
      v_rating: voltageFromPart(stem) || numberOr0(meta.voltage_rating_V),
      i_rating: iRating,
      i_lut: iLut || iRating,
    });
  }
  catalogueCache = parts;
  return parts;
}

/** Dynex IGBT modules ship their own antiparallel diode model (`<part> - DIODE`). */
export function companionDiode(igbtPart: string): string | null {
  const name = `${igbtPart} - DIODE`;
  return catalogue().some((p) => p.part.toUpperCase() === name.toUpperCase())
    ? name
    : null;
}

// ---------------------------------------------------------------------------
// Stresses
// ---------------------------------------------------------------------------

export function deviceStress(
  t: number[],
  v: number[],
  i: number[],
  gate: number[] | null,
): Stress {
  const duration = t.length > 1 ? t[t.length - 1] - t[0] : 0.0;
  let fsw = 0.0;
  if (gate !== null && duration > 0) {
    let rising = 0;
    for (let k = 1; k < gate.length; k += 1) {
      if (gate[k - 1] <= GATE_THRESHOLD && gate[k] > GATE_THRESHOLD)
        rising += 1;
    }
    fsw = rising / duration;
  }
  return {
    v_peak: v.length ? max(v.map(Math.abs)) : 0.0,
    i_peak: i.length ? max(i.map(Math.abs)) : 0.0,
    i_rms: i.length ? Math.sqrt(mean(i.map((x) => x * x))) : 0.0,
    i_avg: i.length ? mean(i.map(Math.abs)) : 0.0,
    fsw,
  };
}

type BandStress = Pick<Stress, 'v_peak' | 'i_peak' | 'i_rms'>;

export const currentBandLimit = (stress: BandStress): number =>
  Math.max(OVERSIZE_LIMIT * stress.i_peak, 4 * stress.i_rms, 10.0);

function shortlist(
  kind: Kind,
  filter: (p: CataloguePart) => boolean,
  stress: BandStress,
): CataloguePart[] {
  const vReq = Math.max(stress.v_peak * VOLTAGE_DERATING, 1.0);
  const iReq = Math.max(stress.i_peak * CURRENT_MARGIN, 0.5);
  let pool = catalogue().filter(
    (p) => p.kind === kind && filter(p) && p.v_rating >= vReq,
  );
  if (pool.length === 0) return [];
  const classes = [...new Set(pool.map((p) => p.v_rating))]
    .sort((a, b) => a - b)
    .slice(0, 2);
  pool = pool.filter((p) => classes.includes(p.v_rating));
  const adequate = pool.filter((p) => p.i_lut >= iReq);
  if (adequate.length === 0) {
    return [...pool].sort((a, b) => b.i_lut - a.i_lut).slice(0, MAX_CANDIDATES);
  }
  const band = adequate.filter((p) => p.i_rating <= currentBandLimit(stress));
  pool = band.length
    ? band
    : [...adequate].sort((a, b) => a.i_rating - b.i_rating).slice(0, 4);
  pool = [...pool].sort(
    (a, b) => a.i_rating - b.i_rating || a.v_rating - b.v_rating,
  );
  return pool.slice(0, MAX_CANDIDATES);
}

function oversizePenalty(part: CataloguePart, stress: BandStress): number {
  const ratio = part.i_rating / Math.max(2.0 * stress.i_rms, 0.5);
  return ratio > 1 ? 0.25 * Math.log2(ratio) : 0.0;
}

interface Candidate extends CataloguePart {
  diode: string | null;
}
interface Ranked extends Candidate {
  loss_w: number;
  per_ref: Record<string, number>;
  score: number;
}

function rationale(
  choice: Ranked,
  stress: Stress,
  ranked: Ranked[],
  tj: number,
): string {
  const f = formatFixed;
  const bits = [
    `${choice.family} rated ${f(choice.v_rating, 0)} V for ${f(stress.v_peak, 0)} V peak ` +
      `(${f(choice.v_rating / Math.max(stress.v_peak, 1e-9), 1)}× margin)`,
    `lowest evaluated loss ${f(choice.loss_w, 3)} W (position total) at Tj ${f(tj, 0)} °C` +
      (stress.fsw >= 1e3 ? ` and ${f(stress.fsw / 1e3, 1)} kHz` : ''),
  ];
  const kind = choice.kind;
  const ratings = catalogue()
    .filter((p) => p.kind === kind && p.v_rating > 0)
    .map((p) => p.v_rating);
  const lowestClass = ratings.length ? Math.min(...ratings) : null;
  if (
    lowestClass &&
    choice.v_rating > 4 * Math.max(stress.v_peak, 1e-9) &&
    choice.v_rating <= 1.2 * lowestClass
  ) {
    bits.push(
      `NOTE: heavily over-rated because the library's lowest ${kind} voltage class is ` +
        `${f(lowestClass, 0)} V; no lower-voltage parts are available to select`,
    );
  }
  if (ranked.length > 1) {
    const runner = ranked[1];
    bits.push(`next best ${runner.part} at ${f(runner.loss_w, 3)} W`);
  }
  return bits.join('; ');
}

/** Same circuit position shares a part: M_A_BOT/M_B_BOT -> M_#_BOT, SW1..SW4 -> SW#. */
export function positionKey(ref: string): string {
  return ref
    .toUpperCase()
    .replace(/\d+/g, '#')
    .replace(/(?<=_)[ABCUVW](?=_|$)/g, '#');
}

/** `{REF: 'PART'}` or `{REF: {part, diode}}`. */
export type Overrides = Record<
  string,
  string | { part: string; diode?: string | null }
>;

export interface SelectionResult {
  selections: Dict[];
  component_models: Record<string, string>;
  tj: number;
  preference: Preference;
  basis: string;
}

/** Python `float(x)` repr key of a voltage class, as the group key used it. */
const classKey = (value: number): string =>
  Number.isInteger(value) ? `${value}.0` : String(value);

function select(
  devices: Map<string, Device>,
  tj: number,
  preference: Preference,
  overridesIn: Overrides | null,
  basis: string,
): SelectionResult {
  const overrides = new Map<string, Overrides[string]>();
  for (const [k, v] of Object.entries(overridesIn ?? {})) {
    overrides.set(k.toUpperCase(), v);
  }

  const evaluate = (ref: string, part: Candidate): Dict | null => {
    const dev = devices.get(ref)!;
    const model = loadModel(part.part);
    if (model === null) return null;
    const [t, v, i, gate] = dev.series;
    return componentLosses(
      t,
      v,
      i,
      gate,
      model,
      tj,
      dev.kind === 'switch',
      part.diode ? loadModel(part.diode) : null,
    );
  };

  const bestDiodeFor = (vRating: number, iPeak: number, iRms: number) => {
    const cands = shortlist('diode', () => true, {
      v_peak: vRating / VOLTAGE_DERATING,
      i_peak: iPeak,
      i_rms: iRms,
    });
    return cands.length ? cands[0].part : null;
  };

  const candidatesFor = (kind: Kind, stress: BandStress): Candidate[] => {
    const out: Candidate[] = [];
    if (kind === 'switch') {
      if (preference === 'auto' || preference === 'mosfet') {
        for (const p of shortlist(
          'switch',
          (x) => x.type === 'MOSFET with Diode',
          stress,
        )) {
          out.push({ ...p, diode: null });
        }
      }
      if (preference === 'auto' || preference === 'igbt' || out.length === 0) {
        let igbts = shortlist('switch', (x) => x.type === 'IGBT', stress);
        if (preference === 'auto' && out.length) {
          igbts = igbts.filter((p) => p.i_rating <= currentBandLimit(stress));
        }
        for (const p of igbts) {
          out.push({
            ...p,
            diode:
              companionDiode(p.part) ??
              bestDiodeFor(p.v_rating, stress.i_peak, stress.i_rms),
          });
        }
      }
    } else {
      for (const p of shortlist('diode', () => true, stress)) {
        out.push({ ...p, diode: null });
      }
    }
    return out;
  };

  const voltageClass = (kind: Kind, vPeak: number): number => {
    const need = vPeak * VOLTAGE_DERATING;
    const classes = [
      ...new Set(
        catalogue()
          .filter((p) => p.kind === kind && p.v_rating >= need)
          .map((p) => p.v_rating),
      ),
    ].sort((a, b) => a - b);
    return classes.length ? classes[0] : -1.0;
  };

  const groups = new Map<string, string[]>();
  for (const [ref, dev] of devices) {
    const key = overrides.has(ref.toUpperCase())
      ? `${dev.kind}:${ref}`
      : `${dev.kind}:${positionKey(ref)}:${classKey(voltageClass(dev.kind, dev.stress.v_peak))}`;
    const list = groups.get(key) ?? [];
    list.push(ref);
    groups.set(key, list);
  }

  const selections: Dict[] = [];
  const componentModels: Record<string, string> = {};
  for (const refs of groups.values()) {
    const kind = devices.get(refs[0])!.kind;
    const stresses = refs.map((r) => devices.get(r)!.stress);
    const stressG: Stress = {
      v_peak: Math.max(...stresses.map((s) => s.v_peak)),
      i_peak: Math.max(...stresses.map((s) => s.i_peak)),
      i_rms: Math.max(...stresses.map((s) => s.i_rms)),
      i_avg: 0,
      fsw: Math.max(...stresses.map((s) => s.fsw)),
    };
    const forced =
      refs.length === 1 ? (overrides.get(refs[0].toUpperCase()) ?? null) : null;
    let cands: Candidate[];
    if (forced) {
      const name = typeof forced === 'string' ? forced : forced.part;
      const part = catalogue().find(
        (p) => p.part.toUpperCase() === String(name).toUpperCase(),
      );
      let diode = typeof forced === 'string' ? null : (forced.diode ?? null);
      if (part && part.type === 'IGBT' && !diode) {
        diode =
          companionDiode(part.part) ??
          bestDiodeFor(part.v_rating, stressG.i_peak, stressG.i_rms);
      }
      cands = part ? [{ ...part, diode }] : [];
    } else {
      cands = candidatesFor(kind, stressG);
    }

    const ranked: Ranked[] = [];
    for (const cand of cands) {
      const perRef: Record<string, number> = {};
      let ok = true;
      for (const ref of refs) {
        const res = evaluate(ref, cand);
        if (res === null) {
          ok = false;
          break;
        }
        perRef[ref] = res.total_loss_w as number;
      }
      if (!ok) continue;
      const total = pySum(Object.values(perRef));
      ranked.push({
        ...cand,
        loss_w: total,
        per_ref: perRef,
        score: total * (1 + oversizePenalty(cand, stressG)),
      });
    }
    ranked.sort((a, b) => a.score - b.score);

    for (const ref of refs) {
      const stress = devices.get(ref)!.stress;
      if (ranked.length === 0) {
        selections.push({
          ref,
          kind,
          stress,
          selected: null,
          note: 'No library part meets the voltage/current stress.',
        });
        continue;
      }
      const choice = ranked[0];
      componentModels[ref.toUpperCase()] = choice.part;
      if (choice.diode)
        componentModels[`${ref.toUpperCase()}_DIODE`] = choice.diode;
      selections.push({
        ref,
        kind,
        group: refs.length > 1 ? refs : null,
        stress: Object.fromEntries(
          Object.entries(stress).map(([k, v]: [string, number]) => [
            k,
            pyRound(v, 4),
          ]),
        ),
        selected: {
          part: choice.part,
          type: choice.type,
          family: choice.family,
          v_rating: choice.v_rating,
          i_rating: choice.i_rating,
          diode: choice.diode,
          loss_w: pyRound(choice.per_ref[ref], 4),
        },
        forced: Boolean(forced),
        reason: forced
          ? 'Chosen by the user'
          : rationale(choice, stressG, ranked, tj) +
            (refs.length > 1
              ? `; shared by ${refs.join(', ')} (same circuit position)`
              : ''),
        alternatives: ranked.slice(1, 6).map((r) => ({
          part: r.part,
          type: r.type,
          family: r.family,
          v_rating: r.v_rating,
          diode: r.diode,
          loss_w: pyRound(r.per_ref[ref], 4),
        })),
        evaluated: ranked.length,
      });
    }
  }

  selections.sort((a, b) => {
    const ka = a.kind !== 'switch' ? 1 : 0;
    const kb = b.kind !== 'switch' ? 1 : 0;
    if (ka !== kb) return ka - kb;
    const ra = a.ref as string;
    const rb = b.ref as string;
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  return {
    selections,
    component_models: componentModels,
    tj,
    preference,
    basis,
  };
}

const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `select_devices(time_series_dir, tj, device_types, preference, overrides)`. */
export function selectDevices(
  dir: string,
  tj = 100.0,
  deviceTypes: Record<string, DeviceKind> | null = null,
  preference: Preference = 'auto',
  overrides: Overrides | null = null,
): SelectionResult {
  const devices = new Map<string, Device>();
  const series = [...collectComponentSeries(dir)].sort(([a], [b]) =>
    codeUnit(a, b),
  );
  for (const [ref, files] of series) {
    if (files.V === undefined || files.I === undefined) continue;
    const kind = classifyRef(ref, files, deviceTypes);
    if (kind === null) continue;
    let s: Series;
    try {
      s = readComponentSeries({ ...files, V: files.V, I: files.I });
    } catch {
      continue;
    }
    if (s[0].length < 2) continue;
    devices.set(ref, { kind, series: s, stress: deviceStress(...s) });
  }
  return select(devices, tj, preference, overrides, 'simulated waveforms');
}

// ---------------------------------------------------------------------------
// Standalone selection: idealised waveforms from entered stresses
// ---------------------------------------------------------------------------

const PERIODS = 4;
const SAMPLES_PER_PERIOD = 200;
const GATE_ON_V = 15.0;
const DIODE_FORWARD_V = 0.8;
const SWITCH_ON_V = 0.5;

/** `_num`: `float(value)` when finite, else null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  try {
    const out = toFloat(value);
    return Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

/** Python truthiness of an optional float. */
const truthyNum = (x: number | null): x is number => x !== null && x !== 0;

function onCurrent(
  duty: number,
  iPeak: number | null,
  iRms: number | null,
  iAvg: number | null,
): [number | null, number | null] {
  if (truthyNum(iPeak) && truthyNum(iRms)) {
    const rOnSq = iRms ** 2 / duty;
    if (rOnSq >= iPeak ** 2) return [iPeak, iPeak];
    const disc = 12 * rOnSq - 3 * iPeak ** 2;
    const start = disc > 0 ? (-iPeak + Math.sqrt(disc)) / 2 : 0.0;
    return [Math.max(0.0, Math.min(start, iPeak)), iPeak];
  }
  if (truthyNum(iRms)) {
    const level = iRms / Math.sqrt(duty);
    return [level, level];
  }
  if (truthyNum(iAvg)) {
    const level = iAvg / duty;
    return [level, level];
  }
  return [iPeak, iPeak];
}

/** `synthetic_series`: a few periods in the loss engine's conventions. */
export function syntheticSeries(
  kind: Kind,
  vBlock: number,
  fsw: number,
  duty: number,
  start: number,
  end: number,
  zvs = false,
): Series {
  const spp = SAMPLES_PER_PERIOD;
  const n = PERIODS * spp + 1;
  const denom = spp * fsw;
  const t: number[] = [];
  const on: boolean[] = [];
  const progress: number[] = [];
  for (let k = 0; k < n; k += 1) {
    t.push(k / denom);
    const phase = (k % spp) / spp;
    if (kind === 'switch') {
      on.push(phase >= 1.0 - duty);
      progress.push((phase - (1.0 - duty)) / Math.max(duty, 1e-9));
    } else {
      on.push(phase < duty);
      progress.push(phase / Math.max(duty, 1e-9));
    }
  }
  const i = progress.map((p, k) =>
    on[k] ? start + (end - start) * Math.min(Math.max(p, 0.0), 1.0) : 0.0,
  );
  if (kind === 'switch') {
    const gate = on.map((x) => (x ? GATE_ON_V : 0.0));
    const v = on.map((x) => (x ? SWITCH_ON_V : vBlock));
    for (let k = 0; k < n; k += 1) {
      const prev = on[(k - 1 + n) % n];
      if (on[k] && !prev) v[k] = zvs ? 0.0 : vBlock;
    }
    return [t, v, i, gate];
  }
  const v = on.map((x) => (x ? DIODE_FORWARD_V : -vBlock));
  return [t, v, i, null];
}

/** Device table from entered stresses, plus the inputs missing per ref. */
function standaloneDevices(
  entries: Dict[],
): [Map<string, Device>, Record<string, string[]>] {
  const devices = new Map<string, Device>();
  const missing: Record<string, string[]> = {};
  entries.forEach((entry, idx) => {
    const rawRef = entry.ref;
    const ref =
      rawRef === undefined || rawRef === null || rawRef === '' || rawRef === 0
        ? `Q${idx + 1}`
        : pyStr(rawRef);
    const kind: Kind =
      pyStr(entry.kind ?? 'switch').toLowerCase() === 'diode'
        ? 'diode'
        : 'switch';
    const vBlock = num(entry.v_block_v);
    const fswKhz = num(entry.fsw_khz);
    const iPeak = num(entry.i_peak_a);
    const iRms = num(entry.i_rms_a);
    const iAvg = num(entry.i_avg_a);
    const dutyIn = num(entry.duty);
    const need: string[] = [];
    if (!truthyNum(vBlock) || vBlock <= 0) need.push('v_block_v');
    if (!truthyNum(fswKhz) || fswKhz <= 0) need.push('fsw_khz');
    if (!(truthyNum(iPeak) || truthyNum(iRms) || truthyNum(iAvg))) {
      need.push('i_peak_a, i_rms_a or i_avg_a');
    }
    if (need.length) {
      missing[ref] = need;
      return;
    }
    const duty = Math.min(0.95, Math.max(0.05, dutyIn ?? 0.5));
    const [start, end] = onCurrent(duty, iPeak, iRms, iAvg);
    const fsw = (fswKhz as number) * 1e3;
    const s = syntheticSeries(
      kind,
      vBlock as number,
      fsw,
      duty,
      start ?? 0,
      end ?? 0,
      Boolean(entry.zvs),
    );
    const stress = deviceStress(...s);
    stress.fsw = fsw;
    devices.set(ref, { kind, series: s, stress });
  });
  return [devices, missing];
}

export type StandaloneResult =
  | { success: false; missing_inputs: Record<string, string[]> }
  | (SelectionResult & {
      success: true;
      loss_analysis: {
        assumptions: { junction_temperature_c: number; waveforms: string };
        components: Dict[];
      };
    });

/** `select_devices_from_stresses(entries, tj, preference, overrides)`. */
export function selectDevicesFromStresses(
  entries: Dict[],
  tj = 100.0,
  preference: Preference = 'auto',
  overrides: Overrides | null = null,
): StandaloneResult {
  const [devices, missing] = standaloneDevices(entries);
  if (Object.keys(missing).length)
    return { success: false, missing_inputs: missing };
  if (devices.size === 0) {
    return {
      success: false,
      missing_inputs: { devices: ['at least one switch or diode'] },
    };
  }
  const selection = select(
    devices,
    tj,
    preference,
    overrides,
    'idealised waveforms from the entered stresses',
  );
  const components: Dict[] = [];
  for (const sel of selection.selections) {
    const chosen = sel.selected as Dict | null;
    if (!chosen) continue;
    const [t, v, i, gate] = devices.get(sel.ref as string)!.series;
    const model = loadModel(chosen.part as string);
    if (!model) continue;
    const res = componentLosses(
      t,
      v,
      i,
      gate,
      model,
      tj,
      sel.kind === 'switch',
      chosen.diode ? loadModel(chosen.diode as string) : null,
    );
    if (res) components.push({ component: sel.ref, ...res });
  }
  const total = (c: Dict) => c.total_loss_w as number;
  components.sort((a, b) =>
    total(a) < total(b) ? 1 : total(a) > total(b) ? -1 : 0,
  );
  return {
    success: true,
    ...selection,
    loss_analysis: {
      assumptions: {
        junction_temperature_c: tj,
        waveforms:
          'idealised (ramp current while conducting, hard switching unless zvs) from the entered stresses',
      },
      components,
    },
  };
}
