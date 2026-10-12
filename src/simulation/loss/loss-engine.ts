/**
 * Port of qdonis-core `simulator/loss_engine.py`: analytical LUT loss engine
 * over the steady-state time-series CSVs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { get, isDict, iter, pyStr, truthy, type Dict } from '../netlist/py';
import {
  max,
  mean,
  min,
  pairwiseSum,
  pyMax0,
  pyRound,
  pySum,
} from '../numeric/numpy';
import { readWhitespaceTable } from '../numeric/pandas-float';
import { JsonLossModel } from './json-loss-model';
import { csvFiles } from './time-series';

const MODELS_DIR = join(ASSETS_ROOT, 'models');
export const LIBRARY_DIR = join(MODELS_DIR, 'library');
const DEFAULT_SWITCH_MODEL = join(MODELS_DIR, 'E3M0060065K.json');
export const DEFAULT_DIODE_MODEL = join(MODELS_DIR, 'C3D10065A.json');
export const DEFAULT_TJ = 25.0;
const GATE_THRESHOLD = 2.5;
const MAX_SAMPLES = 3000;
const SWITCH_TYPES = new Set(['transistor', 'mosfet', 'igbt', 'switch']);

export type DeviceKind = 'switch' | 'diode' | null;
type Event = [number, number];

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

/** `detect_events_from_gate(..., separate_recovery=True)`. */
export function detectEventsFromGate(
  vGate: number[],
  vDs: number[],
  iD: number[],
): [Event[], Event[], Event[], Event[]] {
  const hardOn: Event[] = [];
  const softOn: Event[] = [];
  const turnOff: Event[] = [];
  const recovery: Event[] = [];
  const n = vGate.length;
  if (n < 2) return [hardOn, softOn, turnOff, recovery];

  const above = vGate.map((v) => v > GATE_THRESHOLD);
  for (let k = 1; k < n; k += 1) {
    if (!above[k - 1] && above[k]) {
      const vSw = vDs[k];
      const iPeak = max(iD, k, Math.min(n, k + 20));
      if (vSw > 5.0 && iPeak > 0) hardOn.push([vSw, iPeak]);
      else if (vSw <= 5.0 || iD[k] < 0) softOn.push([vSw, iPeak]);
    }
  }
  for (let k = 1; k < n; k += 1) {
    if (above[k - 1] && !above[k]) {
      const iSw = max(iD, Math.max(0, k - 5), k + 1);
      const vBlock = max(vDs, k, Math.min(n, k + 20));
      if (iSw > 0.1) turnOff.push([vBlock, iSw]);
    }
  }
  const vdsAbove = vDs.map((v) => v > 5.0);
  for (let k = 1; k < n; k += 1) {
    if (!vdsAbove[k - 1] && vdsAbove[k] && !above[k]) {
      const lo = Math.max(0, k - 10);
      const iBefore = pairwiseSum(iD, lo, k - lo) / (k - lo);
      if (iBefore < -0.1) {
        const vBlock = max(vDs, k, Math.min(n, k + 20));
        recovery.push([vBlock, Math.abs(iBefore)]);
      }
    }
  }
  return [hardOn, softOn, turnOff, recovery];
}

/** `detect_events_from_vds` (passive diodes): reverse-recovery turn-offs. */
function detectEventsFromVds(v: number[], i: number[]): Event[] {
  const turnOff: Event[] = [];
  const vMax = max(v);
  const vMin = min(v);
  const vRange = vMax - vMin;
  if (vRange < 5.0) return [];
  const thresholdHigh = vMax - 0.2 * vRange;
  let high = v[0] > (vMax + vMin) / 2;
  for (let k = 1; k < v.length - 1; k += 1) {
    if (high && v[k] < vMin + 0.2 * vRange) {
      const lo = Math.max(0, k - 10);
      const iBefore = pairwiseSum(i, lo, k - lo) / (k - lo);
      const hi = Math.min(v.length, k + 10);
      const vAfter = pairwiseSum(v, k, hi - k) / (hi - k);
      if (iBefore > 0.1) turnOff.push([Math.abs(vAfter), Math.abs(iBefore)]);
      high = false;
    } else if (!high && v[k] > thresholdHigh) {
      high = true;
    }
  }
  return turnOff;
}

/** `semiconductor_types_from_yaml`: {ref: 'switch' | 'diode' | null}. */
export function semiconductorTypesFromYaml(
  design: unknown,
): Record<string, DeviceKind> {
  const types: Record<string, DeviceKind> = {};
  const source = truthy(design) ? design : {};
  const components = get(source, 'components', []);
  for (const comp of truthy(components) ? iter(components) : []) {
    if (!isDict(comp) || !truthy(get(comp, 'ref'))) continue;
    const ctype = pyStr(get(comp, 'type', '')).toLowerCase();
    types[pyStr(comp.ref)] = SWITCH_TYPES.has(ctype)
      ? 'switch'
      : ctype === 'diode'
        ? 'diode'
        : null;
  }
  return types;
}

// ---------------------------------------------------------------------------
// Model library
// ---------------------------------------------------------------------------

let libraryIndexCache: Map<string, string> | null = null;

/** {FILE STEM: path} for every model JSON under the library (sorted walk). */
function libraryIndex(): Map<string, string> {
  if (libraryIndexCache) return libraryIndexCache;
  const index = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) {
        index.set(basename(name, extname(name)).toUpperCase(), path);
      }
    }
  };
  walk(LIBRARY_DIR);
  libraryIndexCache = index;
  return index;
}

const modelCache = new Map<string, JsonLossModel | null>();

export function loadModelPath(path: string): JsonLossModel | null {
  if (modelCache.has(path)) return modelCache.get(path) ?? null;
  let model: JsonLossModel | null = null;
  try {
    model = new JsonLossModel(path);
  } catch {
    model = null;
  }
  modelCache.set(path, model);
  return model;
}

/**
 * `load_model(name)` by library part name (with or without `.json`).
 * Core also accepted arbitrary file paths; that is not exposed here.
 */
export function loadModel(name: string): JsonLossModel | null {
  if (!name) return null;
  const stem = name.toLowerCase().endsWith('.json') ? name.slice(0, -5) : name;
  const path = libraryIndex().get(stem.toUpperCase());
  return path ? loadModelPath(path) : null;
}

const isIgbt = (model: JsonLossModel | null): boolean =>
  model !== null && pyStr(model.deviceType).toUpperCase() === 'IGBT';

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export type SeriesFiles = { V?: string; I?: string; Gate?: string };

/** `collect_component_series`: {ref: {V, I, Gate}} from the CSV exports. */
export function collectComponentSeries(dir: string): Map<string, SeriesFiles> {
  const data = new Map<string, SeriesFiles>();
  const entry = (ref: string): SeriesFiles => {
    let e = data.get(ref);
    if (!e) {
      e = {};
      data.set(ref, e);
    }
    return e;
  };
  for (const name of csvFiles(dir)) {
    const path = join(dir, name);
    const stem = name.slice(0, -4);
    const lowerStem = stem.toLowerCase();
    const rest = stem.slice(stem.indexOf('_') + 1);
    if (lowerStem.startsWith('v_')) {
      entry(rest).V = path;
    } else if (lowerStem.startsWith('i_')) {
      const ref =
        rest.endsWith('_pri') || rest.endsWith('_sec')
          ? rest.slice(0, rest.lastIndexOf('_'))
          : rest;
      const e = entry(ref);
      if (
        e.I === undefined ||
        (!path.endsWith('_pri.csv') && !path.endsWith('_sec.csv'))
      ) {
        e.I = path;
      }
    } else if (lowerStem.startsWith('gate_')) {
      entry(rest).Gate = path;
    }
  }
  return data;
}

/** `pd.read_csv(path, sep=r'\s+', header=None)[label]` for several labels. */
function columns(path: string, ...labels: number[]): number[][] {
  const table = readWhitespaceTable(readFileSync(path, 'latin1'));
  return labels.map((label) => {
    if (label >= table.length) throw new Error(`KeyError: ${label}`);
    return table[label];
  });
}

/** `read_component_series`: aligned (t, v, i, gate|null), P-channel mirrored. */
export function readComponentSeries(
  files: Required<Pick<SeriesFiles, 'V' | 'I'>> & SeriesFiles,
): [number[], number[], number[], number[] | null] {
  let [t, vDs] = columns(files.V, 0, 1);
  let [iD] = columns(files.I, 1);
  let minLen = Math.min(vDs.length, iD.length);
  let vGate: number[] | null = null;
  if (files.Gate !== undefined) {
    [vGate] = columns(files.Gate, 1);
    minLen = Math.min(minLen, vGate.length);
  }
  t = t.slice(0, minLen);
  vDs = vDs.slice(0, minLen);
  iD = iD.slice(0, minLen);
  if (vGate !== null) {
    vGate = vGate.slice(0, minLen);
    const negative = vGate.filter((v) => v < -GATE_THRESHOLD).length;
    const positive = vGate.filter((v) => v > GATE_THRESHOLD).length;
    if (negative > positive) {
      vGate = vGate.map((v) => -v);
      vDs = vDs.map((v) => -v);
      iD = iD.map((v) => -v);
    }
  }
  return [t, vDs, iD, vGate];
}

/** `classify_ref`: 'switch' | 'diode' | null for one telemetry ref. */
export function classifyRef(
  ref: string,
  files: SeriesFiles,
  deviceTypes: Record<string, DeviceKind> | null,
): DeviceKind {
  const upper = ref.toUpperCase();
  if (upper.endsWith('BODY_DIODE') || upper.endsWith('BODY DIODE')) return null;
  if (deviceTypes && Object.keys(deviceTypes).length && ref in deviceTypes) {
    return deviceTypes[ref];
  }
  if (
    files.Gate !== undefined ||
    upper.startsWith('S') ||
    upper.startsWith('M') ||
    upper.startsWith('Q')
  ) {
    return 'switch';
  }
  return upper.startsWith('D') ? 'diode' : null;
}

// ---------------------------------------------------------------------------
// Per-device losses
// ---------------------------------------------------------------------------

function subsample(values: number[]): number[] {
  if (values.length <= 4000) return values;
  const step = Math.max(1, Math.trunc(values.length / MAX_SAMPLES));
  return values.filter((_, k) => k % step === 0);
}

function conductionPower(
  currentsAbs: number[],
  drops: (x: number[]) => number[],
  fraction: number,
): number {
  if (currentsAbs.length === 0) return 0.0;
  const sub = subsample(currentsAbs);
  const d = drops(sub);
  return mean(sub.map((x, k) => x * d[k])) * fraction;
}

const pick = (values: number[], mask: boolean[]): number[] =>
  values.filter((_, k) => mask[k]);
const count = (mask: boolean[]): number => mask.filter(Boolean).length;
/** Python `getattr(model, attr, 0.0) or 0.0` on a numeric metadata value. */
const metaNumber = (value: unknown): number =>
  truthy(value) ? Number(value) : 0.0;

export function componentLosses(
  t: number[],
  vDs: number[],
  iD: number[],
  vGate: number[] | null,
  model: JsonLossModel,
  tj: number,
  isSwitch: boolean,
  customDiode: JsonLossModel | null,
): Dict | null {
  const duration = t.length > 1 ? t[t.length - 1] - t[0] : 0.0;
  if (duration <= 0) return null;
  const n = iD.length;
  const igbt = isSwitch && isIgbt(model);
  let diodeModel = customDiode;
  if (igbt && diodeModel === null)
    diodeModel = loadModelPath(DEFAULT_DIODE_MODEL);

  let pCondFwd = 0.0;
  let pCondRev = 0.0;
  let pDiodeSw = 0.0;
  let hardOn: Event[] = [];
  let softOn: Event[] = [];
  let turnOff: Event[] = [];
  let recovery: Event[] = [];

  if (vGate !== null) {
    [hardOn, softOn, turnOff, recovery] = detectEventsFromGate(vGate, vDs, iD);
    const gateHigh = vGate.map((v) => v > GATE_THRESHOLD);
    const channelMask = igbt
      ? gateHigh.map((g, k) => g && iD[k] > 0)
      : gateHigh.map((g, k) => g && (iD[k] > 0 || iD[k] < 0));
    const diodeMask = igbt
      ? iD.map((i) => i < 0)
      : gateHigh.map((g, k) => !g && iD[k] < 0);

    if (channelMask.some(Boolean)) {
      pCondFwd = conductionPower(
        pick(iD, channelMask).map(Math.abs),
        (x) => model.getConductionVoltageDrops(x, tj, true),
        count(channelMask) / n,
      );
    }
    if (diodeMask.some(Boolean)) {
      let drops: ((x: number[]) => number[]) | null;
      if (igbt || diodeModel !== null) {
        const d = diodeModel;
        if (d === null) {
          throw new TypeError("'NoneType' object has no attribute");
        }
        drops = d.hasDiodeConductionLut
          ? (x) => d.getDiodeVoltageDrops(x, tj)
          : null;
      } else {
        drops = (x) => model.getConductionVoltageDrops(x, tj, false);
      }
      if (drops !== null) {
        pCondRev = conductionPower(
          pick(iD, diodeMask).map(Math.abs),
          drops,
          count(diodeMask) / n,
        );
      }
    }
    if (igbt) {
      const d = diodeModel;
      const eRec = d
        ? pySum(
            recovery.map(([v, i]) =>
              d.getTurnOffEnergy(Math.abs(v), Math.abs(i), tj),
            ),
          )
        : 0.0;
      pDiodeSw = pyMax0(eRec / duration);
    } else {
      turnOff = [...turnOff, ...recovery];
    }
  } else {
    turnOff = detectEventsFromVds(vDs, iD);
    const diodeMask = iD.map(
      (i, k) => Math.abs(i) > 0.1 && Math.abs(vDs[k]) < 5.0,
    );
    if (diodeMask.some(Boolean)) {
      if (model.hasDiodeConductionLut) {
        pCondRev = conductionPower(
          pick(iD, diodeMask).map(Math.abs),
          (x) => model.getDiodeVoltageDrops(x, tj),
          count(diodeMask) / n,
        );
      } else {
        const inst = iD
          .map((i, k) => (diodeMask[k] ? Math.abs(i) * Math.abs(vDs[k]) : null))
          .filter((x): x is number => x !== null);
        pCondRev = mean(inst) * (count(diodeMask) / n);
      }
    }
  }

  const eOn = pySum(
    [...hardOn, ...softOn].map(([v, i]) =>
      model.getTurnOnEnergy(Math.abs(v), Math.abs(i), tj),
    ),
  );
  const eOff = pySum(
    turnOff.map(([v, i]) =>
      model.getTurnOffEnergy(Math.abs(v), Math.abs(i), tj),
    ),
  );
  const pSw = pyMax0((eOn + eOff) / duration);

  const fSw = (hardOn.length + softOn.length) / duration;
  const qg = metaNumber(model.qgNc);
  const vDrv = metaNumber(model.vDrvV);
  const pGate = pyMax0(qg * 1e-9 * vDrv * fSw);
  const vBusEst = vDs.length ? max(vDs) : 0.0;
  const dt = t.length > 1 ? t[1] - t[0] : 0.0;
  const offTime =
    vGate !== null
      ? vGate.filter((v) => v <= GATE_THRESHOLD).length * dt
      : vDs.filter((v) => v > 5.0).length * dt;
  const dOff = offTime / duration;
  const iLeak = metaNumber(model.iLeakageUa);
  const pLeakage = pyMax0(vBusEst * (iLeak * 1e-6) * dOff);

  const pCond = pCondFwd + pCondRev;
  const total = pCond + pSw + pDiodeSw + pGate + pLeakage;
  const r4 = (x: number) => pyRound(x, 4);
  const result: Dict = {
    device_type: isSwitch ? 'switch' : 'diode',
    device_kind: isSwitch ? (igbt ? 'IGBT + diode' : 'MOSFET') : 'Diode',
    model: model.partNumber,
    conduction_loss_w: r4(pCond),
    forward_conduction_loss_w: r4(pCondFwd),
    reverse_conduction_loss_w: r4(pCondRev),
    switching_loss_w: r4(pSw + pDiodeSw),
    gate_drive_loss_w: r4(pGate),
    leakage_loss_w: r4(pLeakage),
    total_loss_w: r4(total),
    hard_turn_on_events: hardOn.length,
    soft_turn_on_events: softOn.length,
    turn_off_events: turnOff.length + (igbt ? recovery.length : 0),
  };
  if (igbt) {
    Object.assign(result, {
      diode_model: diodeModel ? diodeModel.partNumber : null,
      igbt_loss_w: r4(pCondFwd + pSw + pGate + pLeakage),
      diode_conduction_loss_w: r4(pCondRev),
      diode_recovery_loss_w: r4(pDiodeSw),
      diode_loss_w: r4(pCondRev + pDiodeSw),
    });
  }
  return result;
}

export interface LossAnalysis {
  assumptions: {
    junction_temperature_c: number;
    plecs_model: string;
    default_mosfet: string;
    default_diode: string;
  };
  components: Dict[];
}

/** `calculate_losses(dir, tj=, component_models=, device_types=)`. */
export function calculateLosses(
  dir: string,
  tj: number = DEFAULT_TJ,
  componentModels: Record<string, unknown> | null = null,
  deviceTypes: Record<string, DeviceKind> | null = null,
): LossAnalysis {
  const models = new Map<string, unknown>();
  for (const [k, v] of Object.entries(componentModels ?? {})) {
    if (truthy(v)) models.set(k.toUpperCase(), v);
  }
  const custom = models.size ? models : null;

  const defaultSwitch = loadModelPath(DEFAULT_SWITCH_MODEL);
  const defaultDiode = loadModelPath(DEFAULT_DIODE_MODEL);

  const results: Dict[] = [];
  for (const [ref, files] of collectComponentSeries(dir)) {
    if (files.V === undefined || files.I === undefined) continue;
    const kind = classifyRef(ref, files, deviceTypes);
    if (kind === null) continue;
    const isSwitch = kind === 'switch';
    const refUpper = ref.toUpperCase();

    let modelName: unknown = null;
    if (custom) {
      const own = custom.get(refUpper);
      modelName = truthy(own) ? own : custom.get(isSwitch ? 'MOSFET' : 'DIODE');
    }
    let active = truthy(modelName) ? loadModel(pyStr(modelName)) : null;
    if (active === null) active = isSwitch ? defaultSwitch : defaultDiode;
    const diodeName = custom ? custom.get(`${refUpper}_DIODE`) : null;
    const customDiode = truthy(diodeName) ? loadModel(pyStr(diodeName)) : null;
    if (active === null) continue;

    try {
      const [t, vDs, iD, vGate] = readComponentSeries({
        ...files,
        V: files.V,
        I: files.I,
      });
      const entry = componentLosses(
        t,
        vDs,
        iD,
        vGate,
        active,
        tj,
        isSwitch,
        customDiode,
      );
      if (entry) results.push({ component: ref, ...entry });
    } catch {
      // Python logged the traceback and skipped this ref.
    }
  }

  // list.sort(reverse=True) is stable and keeps ties in original order.
  const total = (x: Dict) => x.total_loss_w as number;
  results.sort((a, b) =>
    total(a) < total(b) ? 1 : total(a) > total(b) ? -1 : 0,
  );

  const defaultMosfetName = defaultSwitch
    ? basename(DEFAULT_SWITCH_MODEL)
    : 'N/A';
  const defaultDiodeName = defaultDiode ? basename(DEFAULT_DIODE_MODEL) : 'N/A';
  const plecsModel = custom
    ? 'Custom: ' + [...custom].map(([k, v]) => `${k}=${pyStr(v)}`).join(', ')
    : `MOSFET: ${defaultMosfetName}, Diode: ${defaultDiodeName}`;

  return {
    assumptions: {
      junction_temperature_c: tj,
      plecs_model: plecsModel,
      default_mosfet: defaultMosfetName,
      default_diode: defaultDiodeName,
    },
    components: results,
  };
}
