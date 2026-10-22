/**
 * Component sizing, ported from qdonis-core `topology_improver.py`
 * (`optimize_topology_parameters` minus the LLM call itself): the prompt,
 * post-processing of the model's JSON, the deterministic DAB / three-phase
 * AFE adapters, applying the updates to the YAML, the UI change list and the
 * quick-params line. Values are PyYAML-typed (ints as bigint).
 */

import {
  formatFixed,
  formatG,
  floatRepr,
  isDict,
  PyError,
  pyStr,
  toFloat,
  type Dict,
} from '../netlist/py';
import { isControlBlock } from '../netlist/signal-blocks';
import { pyRound } from '../numeric/numpy';
import { jsonDumpsIndent, yamlDumpFlow } from './py-dump';

export type Updates = Record<string, Dict>;

const f = (v: unknown): number => toFloat(v);
const g = formatG;
const fx = formatFixed;

/** `float(f"{x:.{d}e}")` (round-trip through scientific text). */
const sci = (x: number, digits: number): number =>
  Number(x.toExponential(digits));

/** `f"{x:.{d}e}"`. */
function formatE(x: number, digits: number): string {
  const text = x.toExponential(digits);
  return text.replace(/e([+-])(\d)$/, 'e$10$2');
}

/** Python `str.lower()` of `str(x)`. */
const lowerStr = (x: unknown): string => pyStr(x).toLowerCase();

/** Python truthiness for the values used here. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** Python `a or b`. */
const or = <T>(a: unknown, b: T): unknown => (truthy(a) ? a : b);

const isNum = (v: unknown): v is number | bigint =>
  typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean';

const getDict = (d: unknown, key: string): Dict =>
  isDict(d) && isDict(d[key]) ? d[key] : {};

/** `updates.setdefault(ref, {})`. */
function slot(updates: Updates, ref: string): Dict {
  if (!isDict(updates[ref])) updates[ref] = {};
  return updates[ref];
}

/** JS values from JSON -> Python-typed (integer numbers become ints). */
export function pyTyped(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value))
    return BigInt(value);
  if (Array.isArray(value)) return value.map(pyTyped);
  if (isDict(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, pyTyped(v)]),
    );
  }
  return value;
}

/** `json.loads` keeping ints apart from floats (needs Node 21+ source text). */
export function jsonLoadsPy(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, ctx?: { source?: string }) => {
    if (
      typeof value === 'number' &&
      ctx?.source &&
      /^-?\d+$/.test(ctx.source)
    ) {
      return BigInt(ctx.source);
    }
    return value;
  });
}

/** Python `float(m.group())` on a `[-+]?[\d.]+` match (ValueError like Python). */
function floatOfMatch(text: string): number {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    throw new PyError(
      'ValueError',
      `could not convert string to float: '${text}'`,
    );
  }
  return Number(text);
}

const VOUT_KEYS = ['vout', 'output_voltage', 'v_out', 'output voltage'];

/** `extract_vout_from_params`. */
export function extractVoutFromParams(params: Dict): number | null {
  for (const [key, val] of Object.entries(params)) {
    const keyLower = key.toLowerCase();
    if (VOUT_KEYS.some((k) => keyLower.includes(k))) {
      if (typeof val === 'string') {
        const m = /[-+]?[\d.]+/.exec(val);
        if (m) return floatOfMatch(m[0]);
      } else if (isNum(val)) return f(val);
    } else if (typeof val === 'string') {
      const m =
        /(?:vout|output_voltage|v_out|output voltage)\s*[:=]\s*([-+]?[\d.]+)/i.exec(
          val,
        );
      if (m) return floatOfMatch(m[1]);
    }
  }
  let list: unknown[] | null = null;
  if (Array.isArray(params.derivedParametersList))
    list = params.derivedParametersList;
  else if (isDict(params.specification)) {
    const inner = params.specification.derivedParametersList;
    list = Array.isArray(inner) ? inner : [];
  }
  for (const p of list ?? []) {
    const name = pyStr(isDict(p) ? (p.name ?? '') : '').toLowerCase();
    if (['output voltage', 'vout', 'v_out'].some((kw) => name.includes(kw))) {
      const m = /[-+]?[\d.]+/.exec(pyStr(isDict(p) ? (p.value ?? '') : ''));
      if (m) return floatOfMatch(m[0]);
    }
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, words: string[]): boolean =>
  words.some((w) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`,
      'u',
    ).test(text),
  );

const MEGA_NEXT = ['', 'V', 'W', 'A', 'H', 'h', 'O', 'Ω'];
const MILLI_NEXT = ['V', 'A', 's', 'W', 'H', 'F', 'Ω', 'O', 'v', 'a', 'w'];

function cleanVal(raw: unknown): number | null {
  if (isNum(raw)) return f(raw);
  if (typeof raw !== 'string') return null;
  // Only the SI prefix written right after the number scales it ("65 kHz",
  // "200 mV", "4.7 uF"); letters elsewhere ("380 VDC bus") must not.
  const m = /([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-zµ]*)/.exec(raw);
  if (!m) return null;
  let val = Number(m[1]);
  const unit = m[2];
  const first = unit.slice(0, 1);
  const next = unit.slice(1, 2);
  if (
    unit.slice(0, 3).toLowerCase() === 'meg' ||
    (first === 'M' && MEGA_NEXT.includes(next))
  )
    val *= 1e6;
  else if (first === 'k' || first === 'K') val *= 1e3;
  else if (first === 'u' || first === 'µ') val *= 1e-6;
  else if (first === 'm' && MILLI_NEXT.includes(next)) val *= 1e-3;
  return val;
}

/** `extract_numeric_param`. */
export function extractNumericParam(
  params: Dict | null,
  keywords: string[],
  exclude: string[] = [],
): number | null {
  if (!params || Object.keys(params).length === 0) return null;
  for (const [k, v] of Object.entries(params)) {
    const kLower = k.toLowerCase().trim();
    if (hasWord(kLower, exclude)) continue;
    if (hasWord(kLower, keywords)) {
      const val = cleanVal(v);
      if (val !== null && val > 0) return val;
    }
  }
  const list = or(
    params.derivedParametersList,
    getDict(params, 'specification').derivedParametersList ?? [],
  );
  if (Array.isArray(list)) {
    for (const p of list) {
      const name = pyStr(getDictValue(p, 'name', '')).toLowerCase();
      if (hasWord(name, exclude)) continue;
      if (hasWord(name, keywords)) {
        const val = cleanVal(getDictValue(p, 'value', ''));
        if (val !== null && val > 0) return val;
      }
    }
  }
  const confirmed = params.confirmedParameters ?? [];
  if (Array.isArray(confirmed)) {
    for (const p of confirmed) {
      const id = pyStr(getDictValue(p, 'id', '')).toLowerCase();
      if (hasWord(id, exclude)) continue;
      if (hasWord(id, keywords)) {
        const val = cleanVal(getDictValue(p, 'value', ''));
        if (val !== null && val > 0) return val;
      }
    }
  }
  return null;
}

function getDictValue(d: unknown, key: string, dflt: unknown): unknown {
  if (!isDict(d))
    throw new PyError('AttributeError', "object has no attribute 'get'");
  return key in d ? d[key] : dflt;
}

const STD_SEMI = [
  20, 30, 40, 60, 80, 100, 150, 200, 250, 400, 500, 600, 650, 800, 900, 1000,
  1200, 1700, 3300,
].map(BigInt);
const STD_PASSIVE: Array<number | bigint> = [
  6.3,
  10n,
  16n,
  25n,
  35n,
  50n,
  63n,
  100n,
  160n,
  200n,
  250n,
  350n,
  400n,
  450n,
  500n,
  630n,
  800n,
  1000n,
];

function stdRating(
  vPeak: number,
  ratings: Array<number | bigint>,
  margin = 1.2,
) {
  const required = Math.abs(vPeak) * margin;
  for (const r of ratings) if (f(r) >= required) return r;
  return ratings[ratings.length - 1];
}

/** Python `str(x)` of the assumptions / topology fields for the power regex. */
function powerFromText(params: Dict): number | null {
  const corpus = `${pyStr(params.assumptionsMade ?? '')} ${pyStr(params.recommendedTopology ?? '')}`;
  const m = /(\d+(?:\.\d+)?)\s*(k|K)?\s*W(?:(?![\p{L}\p{N}_])|[^a-zA-Z])/u.exec(
    corpus,
  );
  if (!m) return null;
  let val = Number(m[1]);
  if (m[2]) val *= 1e3;
  return val >= 20.0 ? val : null;
}

const POWER_KEYS = [
  'output_power',
  'output power',
  'total_power',
  'total power',
  'rated_power',
  'rated power',
  'nominal_power',
  'nominal power',
  'pout',
  'p_out',
];
const POWER_EXCLUDE = [
  'aux',
  'auxiliary',
  'gate',
  'driver',
  'standby',
  'loss',
  'dissipation',
  'quiescent',
  'supply',
];
const IOUT_KEYS = [
  'nominal output current',
  'output_current',
  'output current',
  'iout',
  'i_out',
];
const IOUT_EXCLUDE = [
  'input',
  'inrush',
  'aux',
  'auxiliary',
  'gate',
  'range',
  'ripple',
];

function powerOf(params: Dict, vout: number, fallback: number): number {
  let power =
    extractNumericParam(params, POWER_KEYS, POWER_EXCLUDE) ??
    extractNumericParam(
      params,
      ['power', 'watt', 'watts'],
      [...POWER_EXCLUDE, 'factor'],
    );
  const iout = extractNumericParam(params, IOUT_KEYS, IOUT_EXCLUDE);
  if ((power === null || power < 20.0) && iout !== null && iout > 0 && vout > 0)
    power = vout * iout;
  if (power === null || power < 20.0) power = powerFromText(params) ?? power;
  if (power === null || power <= 0) power = fallback;
  return power;
}

/** `_adapt_dab_closed_loop_parameters`; returns the reasoning markdown. */
export function adaptDab(
  yaml: Dict,
  updates: Updates,
  paramsIn: Dict | null,
): string {
  const params = paramsIn ?? {};
  const vin =
    extractNumericParam(
      params,
      [
        'nominal input voltage',
        'input_voltage',
        'input voltage',
        'vin',
        'v_in',
      ],
      [
        'range',
        'min',
        'max',
        'ripple',
        'drop',
        'capacitor',
        'filter',
        'current',
      ],
    ) ?? f(or(getDict(updates, 'VIN').voltage, 60.0));
  const vout =
    extractNumericParam(
      params,
      [
        'nominal output voltage',
        'output_voltage',
        'output voltage',
        'vout',
        'v_out',
      ],
      ['range', 'min', 'max', 'ripple', 'regulation', 'capacitor', 'current'],
    ) ?? 60.0;
  const power = powerOf(params, vout, vout >= 200.0 ? 10000.0 : 2880.0);
  const fsw =
    extractNumericParam(
      params,
      [
        'switching_frequency',
        'switching frequency',
        'frequency',
        'fsw',
        'f_sw',
      ],
      ['resonant'],
    ) ??
    f(
      or(
        getDict(updates, 'Vramp').frequency,
        vin < 100.0 ? 100000.0 : vout >= 200.0 ? 70000.0 : 20000.0,
      ),
    );

  slot(updates, 'VIN').voltage = vin;
  slot(updates, 'V_ref_raw').pwl = `0 0 5m ${g(vout, 6)} 40m ${g(vout, 6)}`;
  const rLoad = power > 0 ? vout ** 2 / power : 16.0;
  slot(updates, 'R_LOAD').resistance = pyRound(rLoad, 4);
  const turnsRatio = vin > 0 ? pyRound(vout / vin, 4) : 1.0;
  const pMaxTarget = 1.5 * power;
  let lk = (vin * (vout / turnsRatio)) / (8.0 * fsw * pMaxTarget);
  const lkChoke = (vin * (vout / turnsRatio)) / (8.0 * fsw * power);
  lk = Math.max(0.5e-6, Math.min(lk, 0.85 * lkChoke));
  slot(updates, 'LLk').inductance = sci(lk, 3);
  const lm = Math.max(500.0e-6, vin ** 2 / (4.0 * fsw * 0.05 * power));
  slot(updates, 'T1').Lm_primary = sci(lm, 3);
  slot(updates, 'T1').turns_ratio = turnsRatio;
  const cout = vout >= 100.0 ? 47.0e-6 : 4.7e-3;
  slot(updates, 'C_OUT').capacitance = cout;
  const kp = vin >= 200.0 ? 0.001 : 0.002;
  const cInt = 1.0e-6;
  const gInt = (kp * cInt) / (rLoad * cout);
  slot(updates, 'B_P').expression = `V(err) * ${g(kp, 6)}`;
  slot(updates, 'G_INT').gain = sci(gInt, 6);
  const tPeriod = 1.0 / fsw;
  const tFall = 1.0e-7;
  const tRise = Math.max(1.0e-7, tPeriod - tFall);
  const ramp = slot(updates, 'Vramp');
  ramp.per = sci(tPeriod, 6);
  ramp.tr = sci(tRise, 6);
  ramp.tf = sci(tFall, 6);
  ramp.pw = 0.0;

  if (isDict(yaml.analysis)) {
    const reqs = getDict(yaml.analysis, 'transient').requirements ?? [];
    for (const req of Array.isArray(reqs) ? reqs : []) {
      if (!isDict(req)) continue;
      for (const e of Array.isArray(req.environment) ? req.environment : []) {
        if (isDict(e) && 't_stop' in e && f(e.t_stop) > 0.04) e.t_stop = 0.04;
      }
      for (const out of Array.isArray(req.outputs) ? req.outputs : []) {
        if (isDict(out) && out.var === 'pout_avg_w') {
          // Reference the load so the deck's design summary carries R_LOAD to re-runs.
          out.formula = '(abs([Vout_avg])**2) / {components.R_LOAD.resistance}';
          out.description = `Delivered Output Power (${floatRepr(pyRound(power, 1))}W nominal)`;
        }
      }
    }
    for (const key of ['spice_settings', 'transient']) {
      const sec = yaml.analysis[key];
      if (isDict(sec)) {
        delete sec.save;
        if (isDict(sec.spice_settings)) delete sec.spice_settings.save;
      }
    }
  }
  delete yaml.save;

  const vRmsPri = pyRound(vin * 0.7071, 2);
  const iPeakPri = pyRound((power / vin) * 1.25, 2);
  const iRmsPri = pyRound((power / vin) * 0.88, 2);
  const stdPri = stdRating(vin, STD_SEMI);
  const lowPri = vin <= 100.0;
  for (const sw of ['SW1', 'SW2', 'SW3', 'SW4']) {
    Object.assign(slot(updates, sw), {
      part_number: lowPri ? 'CSD17577Q5A' : 'C3M0015065D',
      rds_on: lowPri ? 0.0032 : 0.015,
      cost: lowPri ? 1.15 : 6.5,
      technology: lowPri ? 'Si' : 'SiC',
      tr: 6.0e-9,
      tf: 7.0e-9,
      v_peak: vin,
      v_rms: vRmsPri,
      i_peak: iPeakPri,
      i_rms: iRmsPri,
      std_voltage_rating: stdPri,
    });
  }
  const deadTime = 0.02;
  for (const d of ['DSW1', 'DSW2', 'DSW3', 'DSW4']) {
    Object.assign(slot(updates, d), {
      Bv: pyRound(1.5 * vin, 1),
      Rs: 0.0001,
      v_peak: vin,
      i_peak: iPeakPri,
      i_rms: pyRound(iPeakPri * deadTime ** 0.5, 2),
      std_voltage_rating: stdPri,
    });
  }
  const vRmsSec = pyRound(vout * 0.7071, 2);
  const iPeakSec = pyRound((power / vout) * 1.25, 2);
  const iRmsSec = pyRound((power / vout) * 0.88, 2);
  const stdSec = stdRating(vout, STD_SEMI);
  const lowSec = vout <= 100.0;
  for (const sw of ['SW5', 'SW6', 'SW7', 'SW8']) {
    Object.assign(slot(updates, sw), {
      part_number: lowSec ? 'IPP040N06N' : 'IPP65R150CFD7A',
      rds_on: lowSec ? 0.02 : 0.15,
      cost: lowSec ? 2.1 : 4.5,
      technology: lowSec ? 'Si' : 'CoolMOS',
      tr: 1.1e-8,
      tf: 8.0e-9,
      v_peak: vout,
      v_rms: vRmsSec,
      i_peak: iPeakSec,
      i_rms: iRmsSec,
      std_voltage_rating: stdSec,
    });
  }
  for (const d of ['DSW5', 'DSW6', 'DSW7', 'DSW8']) {
    Object.assign(slot(updates, d), {
      Bv: pyRound(1.5 * vout, 1),
      Rs: 0.001,
      v_peak: vout,
      i_peak: iPeakSec,
      i_rms: pyRound(iPeakSec * deadTime ** 0.5, 2),
      std_voltage_rating: stdSec,
    });
  }
  Object.assign(slot(updates, 'LLk'), {
    v_peak: vin,
    v_rms: vRmsPri,
    i_peak: iPeakPri,
    i_rms: iRmsPri,
    i_ripple: pyRound(iPeakPri * 0.3, 2),
    std_voltage_rating: stdRating(vin, STD_PASSIVE),
  });
  const iOut = power / vout;
  const iBridgeRms = 2.0 ** 0.5 * iRmsSec;
  Object.assign(slot(updates, 'C_OUT'), {
    v_peak: vout,
    i_rms: pyRound(Math.max(0.0, iBridgeRms ** 2 - iOut ** 2) ** 0.5, 2),
    i_peak: pyRound(Math.max(iPeakSec - iOut, iOut), 2),
    std_voltage_rating: stdRating(vout, STD_PASSIVE),
  });
  Object.assign(slot(updates, 'T1'), {
    k_coupling: 0.99999,
    phase: 'same',
    Rp: 0.0005,
    Rs: 0.001,
    core_loss_resistance: 1000000.0,
    v_peak_primary: vin,
    v_rms_primary: vRmsPri,
    i_peak_primary: iPeakPri,
    i_rms_primary: iRmsPri,
    v_peak_secondary: vout,
    v_rms_secondary: vRmsSec,
    i_peak_secondary: iPeakSec,
    i_rms_secondary: iRmsSec,
  });

  const fPlant = 1.0 / (2.0 * 3.1415926535 * rLoad * cout);
  return `## Dual Active Bridge (DAB) Parameter Optimization & Control Tuning

### 1. Electrical Operating Point
- **Input Voltage ($V_{in}$)**: $${g(vin, 4)}\\,\\text{V}$
- **Target Output Voltage ($V_{out}$)**: $${g(vout, 4)}\\,\\text{V}$
- **Nominal Output Power ($P_{out}$)**: $${g(power, 4)}\\,\\text{W}$
- **Switching Frequency ($f_{sw}$)**: $${fx(fsw / 1e3, 1)}\\,\\text{kHz}$ ($T_{sw} = ${fx(tPeriod * 1e6, 2)}\\,\\mu\\text{s}$)

### 2. Power Stage & Transformer Design
- **Load Resistance**:
  $$R_{LOAD} = \\frac{V_{out}^2}{P_{out}} = \\frac{${g(vout, 4)}^2}{${g(power, 4)}} = ${fx(rLoad, 4)}\\,\\Omega$$
- **Transformer Turns Ratio**:
  $$n = \\frac{V_{out}}{V_{in}} = \\frac{${g(vout, 4)}}{${g(vin, 4)}} = ${fx(turnsRatio, 4)}$$
- **Leakage Inductance ($L_k$)**: Sized with $1.5\\times$ dynamic power headroom to prevent power choking:
  $$P_{max} = \\frac{V_{in} \\cdot (V_{out} / n)}{8 \\cdot f_{sw} \\cdot L_k} \\ge 1.5 \\cdot P_{out}$$
  $$L_k = ${fx(lk * 1e6, 3)}\\,\\mu\\text{H} \\quad (L_{k,choke} = ${fx(lkChoke * 1e6, 3)}\\,\\mu\\text{H})$$
- **Magnetizing Inductance ($L_m$)**: Primary magnetizing ripple kept $< 5\\%$ of nominal primary current:
  $$L_m = ${fx(lm * 1e6, 1)}\\,\\mu\\text{H} \\ge 500\\,\\mu\\text{H}$$
- **Output Capacitor ($C_{OUT}$)**: Sized at $${fx(cout * 1e6, 1)}\\,\\mu\\text{F}$ for rapid transient settling.

### 3. Closed-Loop Compensator Tuning (Pole-Zero Cancellation)
- **Plant Load Pole**:
  $$f_p = \\frac{1}{2\\pi R_{LOAD} C_{OUT}} = ${fx(fPlant, 1)}\\,\\text{Hz}$$
- **Zero Placement via Transconductance Integrator**:
  $$f_z = \\frac{G_{INT}}{2\\pi K_p C_{INT}} = f_p$$
- **Controller Gains**:
  - Proportional Gain: $K_p = ${floatRepr(kp)}$
  - Transconductance Gain: $G_{INT} = \\frac{K_p \\cdot C_{INT}}{R_{LOAD} \\cdot C_{OUT}} = ${fx(gInt * 1e6, 3)}\\,\\mu\\text{A/V}$
- **Soft-Start Reference**: PWL target smoothly ramps from $0\\,\\text{V}$ to $${g(vout, 4)}\\,\\text{V}$ at $5\\,\\text{ms}$.
- **Telemetry & Waveforms**: Restrictive \`save\` commands and \`xl\` zoom limits are suppressed to ensure full switch telemetry and full-window transient waveforms.
`;
}

/** `_has_comp`. */
const hasComp = (yaml: Dict, ref: string): boolean =>
  allComponents(yaml.components ?? []).some(([c]) => or(c.ref, c.id) === ref);

/** Python `any(c.get("ref") == ref for c in yaml_dict.get("components", []))`. */
const hasTopLevel = (yaml: Dict, ref: string): boolean =>
  Array.isArray(yaml.components) &&
  yaml.components.some((c) => isDict(c) && c.ref === ref);

/**
 * `_control_update` (beyond chat-first): the chat-first adapters scale
 * control loops written as behavioural sources (`legacyRef`); the library
 * builds the same loops from control blocks. Updates whichever form the
 * template has: the block when only it exists (`block` undefined: the block
 * needs no change), else the source.
 */
function controlUpdate(
  yaml: Dict,
  updates: Updates,
  legacyRef: string,
  legacy: Dict,
  blockRef?: string,
  block?: Dict,
): void {
  if (blockRef && hasComp(yaml, blockRef) && !hasComp(yaml, legacyRef)) {
    if (block && Object.keys(block).length)
      Object.assign(slot(updates, blockRef), block);
    return;
  }
  Object.assign(slot(updates, legacyRef), legacy);
}

const present = (v: unknown): boolean => v !== null && v !== undefined;

/** `_comp_param`: the update's value if any, else the template's. */
function compParam(
  yaml: Dict,
  updates: Updates,
  ref: string,
  keys: string | string[],
  dflt: unknown = null,
): unknown {
  const names = (typeof keys === 'string' ? [keys] : keys).map((k) =>
    k.toLowerCase(),
  );
  const upd = or(updates[ref], {});
  for (const k of names) {
    for (const [uk, uv] of Object.entries(isDict(upd) ? upd : {})) {
      if (uk.toLowerCase() === k && present(uv)) return uv;
    }
  }
  for (const [comp] of allComponents(yaml.components ?? [])) {
    if (or(comp.ref, comp.id) !== ref) continue;
    const params = or(comp.params, or(comp.parameters, {}));
    for (const k of names) {
      for (const [pk, pv] of Object.entries(isDict(params) ? params : {})) {
        if (pk.toLowerCase() === k && present(pv)) return pv;
      }
    }
  }
  return dflt;
}

/** `_num`. */
function num(value: unknown, dflt: number): number {
  const v = parseEngToNum(value);
  return v !== null && !Number.isNaN(v) ? v : dflt;
}

/** `float(f"{x:.{d}g}")`. */
const gNum = (x: number, digits: number): number => Number(g(x, digits));

const AFE_VIN_KEYS = [
  'nominal input voltage',
  'input_voltage',
  'input voltage',
  'vin',
  'v_in',
  'line_voltage',
  'grid_voltage',
];

/** `_adapt_three_phase_afe_parameters`; returns the reasoning markdown. */
export function adaptAfe(
  yaml: Dict,
  updates: Updates,
  paramsIn: Dict | null,
): string {
  const params = paramsIn ?? {};
  const vin =
    extractNumericParam(params, AFE_VIN_KEYS, [
      'range',
      'min',
      'max',
      'ripple',
      'drop',
      'capacitor',
      'filter',
      'current',
      'phase',
    ]) ?? 380.0;
  const vout =
    extractNumericParam(
      params,
      [
        'nominal output voltage',
        'output_voltage',
        'output voltage',
        'vout',
        'v_out',
        'dc_bus',
        'bus_voltage',
      ],
      ['range', 'min', 'max', 'ripple', 'regulation', 'capacitor', 'current'],
    ) ?? 700.0;
  const power = powerOf(params, vout, vout >= 600.0 ? 10000.0 : 3000.0);

  const vPhaseRms = vin / Math.sqrt(3.0);
  const vPhasePk = vPhaseRms * Math.sqrt(2.0);
  const rLoad = power > 0 ? vout ** 2 / power : 49.0;
  const iPhaseRms = vin > 0 ? power / (Math.sqrt(3.0) * vin) : 15.2;
  const iPhasePk = Math.sqrt(2.0) * iPhaseRms;
  const iMax = Math.max(12.0, pyRound(1.4 * iPhasePk, 1));
  const iMaxText = floatRepr(iMax);
  const vHalf = vout / 2.0;
  // (core also migrates pre-block templates: R_N_star -> R_N_TOP / R_N_BOT,
  // B_INT -> G_INT; no library template or saved design has them.)

  for (const v of ['V_A', 'V_B', 'V_C'])
    slot(updates, v).amplitude = pyRound(vPhasePk, 2);
  slot(updates, 'R_DC').resistance = pyRound(rLoad, 2);
  // 0.5 mH boost + 0.1 mH EMI inductors keep the reactive drop (wLI) small
  for (const l of ['LA', 'LB', 'LC']) slot(updates, l).inductance = 0.5e-3;
  for (const l of ['L_EMI_A', 'L_EMI_B', 'L_EMI_C'])
    slot(updates, l).inductance = 0.1e-3;
  const cDc =
    power >= 80000.0
      ? 15e-3
      : power >= 40000.0
        ? 5e-3
        : power >= 20000.0
          ? 3e-3
          : 2.2e-3;
  Object.assign(slot(updates, 'C_DC'), { capacitance: cDc, ic: vout });
  slot(updates, 'R_N_TOP').resistance = '10k';
  slot(updates, 'R_N_BOT').resistance = '10k';

  controlUpdate(
    yaml,
    updates,
    'B_ERR',
    { expression: `${g(vout, 4)} - v(V_DC)` },
    'REF_V',
    { value: vout },
  );
  controlUpdate(
    yaml,
    updates,
    'B_P',
    { expression: 'v(V_ERR) * 0.02' },
    'KP_V',
    { gain: 0.02 },
  );
  // Integrator ki = G_INT / C_INT = 5 mA/V / 10 uF
  controlUpdate(yaml, updates, 'G_INT', { gain: 0.005 }, 'INT_V', {
    ki: 500.0,
    upper: iMax,
  });
  controlUpdate(
    yaml,
    updates,
    'C_INT',
    { capacitance: 10e-6, ic: pyRound(iPhasePk, 2) },
    'INT_V',
    { ic: pyRound(iPhasePk, 2) },
  );
  controlUpdate(yaml, updates, 'R_INT', { resistance: '10Meg' }, 'INT_V');
  controlUpdate(
    yaml,
    updates,
    'C_MAG_FLT',
    { capacitance: 1e-6, ic: pyRound(iPhasePk, 2) },
    'LPF_MAG',
    { ic: pyRound(iPhasePk, 2) },
  );
  controlUpdate(
    yaml,
    updates,
    'B_VERR_RAW',
    {
      expression: `((v(V_ERR) * 0.02) + v(V_I)) > ${iMaxText} ? ${iMaxText} : (((v(V_ERR) * 0.02) + v(V_I)) < 0 ? 0 : ((v(V_ERR) * 0.02) + v(V_I)))`,
    },
    'LIM_PI',
    { upper: iMax },
  );
  for (const ph of ['A', 'B', 'C']) {
    controlUpdate(
      yaml,
      updates,
      `B_REF${ph}`,
      {
        expression: `v(I_MAG) * (v(V_${ph}_node) - v(N_star)) / ${fx(vPhasePk, 2)}`,
      },
      `REF_${ph}`,
      { gain: `1/${fx(vPhasePk, 2)}` },
    );
    // Inner current loop: normalised grid-voltage feed-forward + proportional current feedback
    const ff = `((10 * (v(V_${ph}_node) - v(N_star)) / ${fx(vHalf, 2)}) - 0.1 * (v(I_REF_${ph}) - v(V_IACT_${ph})))`;
    controlUpdate(
      yaml,
      updates,
      `B_ERR_${ph}`,
      { expression: `${ff} > 9.5 ? 9.5 : (${ff} < -9.5 ? -9.5 : ${ff})` },
      `K_FF_${ph}`,
      { gain: `10/${fx(vHalf, 2)}` },
    );
  }
  controlUpdate(
    yaml,
    updates,
    'VTRI',
    { v1: -10n, v2: 10n, td: 0n, tr: '25u', tf: '25u', pw: 0n, per: '50u' },
    'CAR',
    { frequency: 20000.0, low: -10n, high: 10n },
  );
  // Positive control effort drives the bottom switches
  for (const [ph, top, bot] of [
    ['A', 'B1', 'B4'],
    ['B', 'B2', 'B5'],
    ['C', 'B3', 'B6'],
  ]) {
    controlUpdate(
      yaml,
      updates,
      top,
      {
        expression: `7.5 * (1 + tanh(5 * (v(V_CTRL_${ph}) - v(V_TRI) - 0.2)))`,
      },
      `CMP_${ph}_TOP`,
    );
    controlUpdate(
      yaml,
      updates,
      bot,
      {
        expression: `7.5 * (1 + tanh(5 * (v(V_TRI) - 0.2 - v(V_CTRL_${ph}))))`,
      },
      `CMP_${ph}_BOT`,
    );
  }
  // Ideal diodes and MOSFETs: no reverse-recovery (Tt) spikes
  const bv = Math.max(1200.0, pyRound(1.5 * vout, 1));
  if (!('models' in yaml)) yaml.models = [];
  const models: unknown[] = Array.isArray(yaml.models) ? yaml.models : [];
  yaml.models = [
    ...models.filter(
      (m) =>
        !(
          typeof m === 'string' &&
          (m.includes('dmodel1') || m.includes('sic_mosfet'))
        ),
    ),
    `.model dmodel1 D(Is=1e-12 n=1.1 Rs=0.001 Cjo=5e-11 Bv=${fx(bv, 0)} Ibv=1e-06)`,
    '.model sic_mosfet NMOS(Vto=3 Lambda=0.01 Kp=8.333 Cbd=0.3n Cbs=0.3n Cgdo=0.3n Is=1e-14 Rs=0.015)',
  ];
  for (const d of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
    Object.assign(slot(updates, d), { Bv: bv, Rs: 0.001, Cjo: 50e-12 });
    for (const comp of Array.isArray(yaml.components) ? yaml.components : []) {
      if (isDict(comp) && comp.ref === d && isDict(comp.params))
        delete comp.params.Tt;
    }
  }
  for (const sw of [
    'M_A_TOP',
    'M_A_BOT',
    'M_B_TOP',
    'M_B_BOT',
    'M_C_TOP',
    'M_C_BOT',
  ]) {
    Object.assign(slot(updates, sw), {
      part_number: 'C3M0015065D',
      rds_on: 0.015,
      tr: 10e-9,
      v_peak: vout,
      i_peak: pyRound(iPhasePk, 2),
      i_rms: pyRound(iPhaseRms, 2),
    });
  }
  if (isDict(yaml.analysis)) {
    const trans = yaml.analysis.transient ?? {};
    if (isDict(trans)) {
      if (!isDict(trans.spice_settings)) trans.spice_settings = {};
      const ss = trans.spice_settings as Dict;
      ss.use_ic = true;
      ss.method = 'trap';
      ss.trtol = 7n;
      ss.ic = `v(V_DC)=${g(vout, 4)} v(V_I)=${fx(iPhasePk, 2)} v(I_MAG)=${fx(iPhasePk, 2)}`;
      for (const req of Array.isArray(trans.requirements)
        ? trans.requirements
        : []) {
        if (!isDict(req)) continue;
        if (!isDict(req.criteria)) req.criteria = {};
        (req.criteria as Dict).target_vout = vout;
        (req.criteria as Dict).tolerance_pct = 5.0;
        for (const env of Array.isArray(req.environment)
          ? req.environment
          : []) {
          if (!isDict(env)) continue;
          env.t_step = 1.0e-6;
          env.t_max_step = 1.0e-6;
          env.t_stop = 0.05;
          env.t_start = 0.04;
        }
        for (const meas of Array.isArray(req.measurement)
          ? req.measurement
          : []) {
          if (
            !isDict(meas) ||
            !['V_DC_OUT', 'VDC_OUT'].includes(meas.ref as string)
          )
            continue;
          meas.ref = 'VOUT';
          if (!('plot' in meas)) meas.plot = {};
          if (isDict(meas.plot)) {
            meas.plot.title = 'Output DC Voltage';
            meas.plot.x_axis = 'time';
          }
        }
        for (const out of Array.isArray(req.outputs) ? req.outputs : []) {
          if (isDict(out) && out.var === 'vout_avg_v') {
            out.description = `Regulated DC Output Voltage (${g(vout, 4)}V target)`;
          }
        }
      }
    }
  }
  return `## Three-Phase Active Front End (AFE) Parameter Optimization & Control Loop Stabilization

### 1. Operating Specifications
- **Grid Voltage ($V_{in(L-L)}$)**: $${g(vin, 4)}\\,\\text{V}_{\\text{RMS}}$ ($V_{phase,pk} = \\frac{${g(vin, 4)}}{\\sqrt{3}} \\cdot \\sqrt{2} = ${fx(vPhasePk, 2)}\\,\\text{V}$)
- **Target DC Bus ($V_{out}$)**: $${g(vout, 4)}\\,\\text{V}_{\\text{DC}}$
- **Nominal Output Power ($P_{out}$)**: $${g(power, 4)}\\,\\text{W}$
- **DC Load Resistance**:
  $$R_{DC} = \\frac{V_{out}^2}{P_{out}} = \\frac{${g(vout, 4)}^2}{${g(power, 4)}} = ${fx(rLoad, 2)}\\,\\Omega$$

### 2. AC Grid Currents & Modulation
- **Nominal Grid Current (RMS)**:
  $$I_{phase,RMS} = \\frac{P_{out}}{\\sqrt{3} \\cdot V_{in}} = \\frac{${g(power, 4)}}{\\sqrt{3} \\cdot ${g(vin, 4)}} = ${fx(iPhaseRms, 2)}\\,\\text{A}$$
- **Peak Phase Current ($I_{phase,pk}$)**:
  $$I_{phase,pk} = \\sqrt{2} \\cdot I_{phase,RMS} = ${fx(iPhasePk, 2)}\\,\\text{A}$$
- **Current Reference Clamp**: Set to $${fx(iMax, 1)}\\,\\text{A}$ ($1.4\\times$ nominal peak headroom).
- **Modulation Index**: $m = \\frac{V_{phase,pk}}{V_{DC} / 2} = \\frac{${fx(vPhasePk, 2)}}{${fx(vHalf, 1)}} = ${fx(vPhasePk / vHalf, 3)} < 1.0$ (linear SPWM operating region).

### 3. Physics, Hardware & Simulation Stability Fixes
- **Inductor Voltage Saturation Prevention**: Boost inductors sized to $0.5\\,\\text{mH}$ and EMI inductors to $0.1\\,\\text{mH}$ ($0.6\\,\\text{mH}$ total vs previous $6\\,\\text{mH}$), eliminating the massive reactive voltage drop ($\\omega L I$) that previously starved the converter and distorted the AC current.
- **DC Buffer Capacitance Sizing**: Scaled $C_{DC}$ to $${fx(cDc * 1e3, 0)}\\,\\text{mF}$ ($${fx(cDc * 1e6, 0)}\\,\\mu\\text{F}$) to provide adequate buffer energy storage between $50\\,\\text{Hz}$ grid peaks, flattening DC bus voltage ripple to $< 1\\%$.
- **Inverted PWM Polarity Correction**: Positive current error correctly mapped to bottom MOSFETs to charge boost inductors against ground without shorting the DC bus.
- **Normalized Grid Voltage Feedforward**: Injected normalized feedforward term ($V_{FF} = 10 \\cdot \\frac{v(V_{ph}) - v(N_{star})}{V_{DC}/2}$) with anti-windup clamping to eliminate duty-cycle blowup.
- **Continuous-Time VCCS Integrator**: Replaced discontinuous ternary integrator with continuous-time transconductance integrator ($G_{INT} = 5\\,\\text{mA/V}$) and dampened proportional gain ($K_p = 0.02$).
- **Neutral Point Midpoint Anchoring**: Connected two $10\\,\\text{k}\\Omega$ balancing resistors ($R_{N,TOP}, R_{N,BOT}$) between $V_{DC}$, $N_{star}$, and ground, eliminating floating-node solver drift.
- **Diode Shoot-Through Prevention**: Eliminated transit time ($T_t$) reverse-recovery shoot-through spikes on freewheeling diodes.
- **Steady-State Inrush Suppression**: Precharged $C_{DC}$ to $${g(vout, 4)}\\,\\text{V}$, $C_{INT}$ to $${fx(iPhasePk, 2)}\\,\\text{V}$, and $C_{MAG,FLT}$ to $${fx(iPhasePk, 2)}\\,\\text{V}$ with \`.tran uic\`.
- **Simulation Anti-Aliasing**: Set carrier frequency to $20\\,\\text{kHz}$ with $1\\,\\mu\\text{s}$ transient timestep resolution.
`;
}

const PFC_TOPOLOGIES = new Set([
  'acdc_single_phase_boost_power_factor_correction',
  'acdc_interleaved_boost_power_factor_correction',
  'acdc_totem_pole_power_factor_correction',
  'acdc_flyback_pfc_dcm',
]);

type OperatingPoint = [number, number, number, number];

/** `_single_phase_operating_point`: (Vin rms, Vout, Pout, f_line). */
function singlePhaseOperatingPoint(
  paramsIn: Dict | null,
  defaults: OperatingPoint,
): OperatingPoint {
  const [vinD, voutD, pD, fD] = defaults;
  const params = paramsIn ?? {};
  let vin = extractNumericParam(
    params,
    [
      'nominal input voltage',
      'input_voltage',
      'input voltage',
      'vin',
      'v_in',
      'line_voltage',
      'line voltage',
      'grid_voltage',
      'ac input voltage',
    ],
    [
      'range',
      'min',
      'max',
      'ripple',
      'drop',
      'capacitor',
      'filter',
      'current',
      'frequency',
    ],
  );
  const vout = extractNumericParam(
    params,
    [
      'nominal output voltage',
      'output_voltage',
      'output voltage',
      'vout',
      'v_out',
      'dc_bus',
      'bus_voltage',
      'dc bus voltage',
    ],
    [
      'range',
      'min',
      'max',
      'ripple',
      'regulation',
      'capacitor',
      'current',
      'tolerance',
    ],
  );
  let power = extractNumericParam(
    params,
    [
      'output_power',
      'output power',
      'total_power',
      'rated_power',
      'rated power',
      'nominal_power',
      'nominal power',
      'pout',
      'p_out',
      'power',
    ],
    [...POWER_EXCLUDE, 'factor', 'density'],
  );
  if (power === null && vout) {
    const iout = extractNumericParam(
      params,
      ['output current', 'output_current', 'iout', 'i_out'],
      ['input', 'inrush', 'ripple', 'range'],
    );
    if (iout) power = vout * iout;
  }
  let fLine = extractNumericParam(params, [
    'input frequency',
    'line frequency',
    'grid frequency',
    'ac frequency',
    'mains frequency',
    'input_frequency',
    'line_frequency',
  ]);
  if (fLine !== null && !(fLine >= 40.0 && fLine <= 440.0)) fLine = null;
  // A spec written as a peak value ("325 Vpk") is converted back to RMS.
  for (const [k, v] of Object.entries(params)) {
    if (
      typeof v === 'string' &&
      vin !== null &&
      /input/i.test(k) &&
      /\b(pk|peak)\b/i.test(v)
    ) {
      vin = vin / 2 ** 0.5;
      break;
    }
  }
  return [vin || vinD, vout ? Math.abs(vout) : voutD, power || pD, fLine || fD];
}

const PFC_DEFAULTS: Record<string, OperatingPoint> = {
  acdc_single_phase_boost_power_factor_correction: [230.0, 385.0, 370.0, 50.0],
  acdc_interleaved_boost_power_factor_correction: [230.0, 385.0, 370.0, 50.0],
  acdc_totem_pole_power_factor_correction: [200.0, 400.0, 4000.0, 50.0],
  acdc_flyback_pfc_dcm: [230.0, 12.0, 30.0, 50.0],
};

/**
 * `_adapt_single_phase_pfc`: the PFC control loops are hidden from the model
 * and hard-code the template's operating point, so they are rescaled here.
 */
function adaptSinglePhasePfc(
  yaml: Dict,
  updates: Updates,
  params: Dict | null,
): string {
  const topologyId = lowerStr(yaml.id ?? '');
  const [vinRms, vout, power, fLine] = singlePhaseOperatingPoint(
    params,
    PFC_DEFAULTS[topologyId],
  );
  const vpk = vinRms * Math.sqrt(2.0);
  const rLoad = vout ** 2 / power;
  const notes = [
    '## Deterministic PFC control scaling',
    `- Line: $V_{in,rms} = ${g(vinRms, 4)}\\,V$, $V_{pk} = \\sqrt{2} V_{in,rms} = ${g(vpk, 4)}\\,V$, $f_{line} = ${g(fLine, 4)}\\,Hz$`,
    `- Load: $R_{LOAD} = V_{out}^2 / P_{out} = ${g(vout, 4)}^2 / ${g(power, 4)} = ${g(rLoad, 4)}\\,\\Omega$`,
  ];
  // Twice-line-frequency ripple: C = P / (2*pi*2*f_line * Vout * dV)
  const holdUpCap = (ref: string, rippleFrac = 0.05): number => {
    const cMin = power / (2 * Math.PI * 2 * fLine * vout * rippleFrac * vout);
    const cNow = num(compParam(yaml, updates, ref, 'capacitance'), 0.0);
    return Math.max(cNow, cMin);
  };

  if (
    topologyId === 'acdc_single_phase_boost_power_factor_correction' ||
    topologyId === 'acdc_interleaved_boost_power_factor_correction'
  ) {
    const nPhases = topologyId.includes('interleaved') ? 2 : 1;
    Object.assign(slot(updates, 'VAC'), {
      amplitude: pyRound(vpk, 2),
      frequency: fLine,
    });
    slot(updates, 'R1').resistance = pyRound(rLoad, 3);
    const vref = num(
      compParam(
        yaml,
        updates,
        'VREF',
        'voltage',
        compParam(yaml, updates, 'REF_V', 'value'),
      ),
      5.0,
    );
    const r3 = num(compParam(yaml, updates, 'R3', 'resistance'), 10e3);
    slot(updates, 'R2').resistance = pyRound(r3 * (vout / vref - 1.0), 1);
    // I_pk = k * |v_line| * V_COMP with V_COMP ~ 2.5 V (half its clamp) at full load
    const iPk = (2.0 * power) / (0.95 * vpk) / nPhases;
    const kMult = iPk / (vpk * 2.5);
    const lineSense = nPhases > 1 ? 'abs(V(a,b))' : 'V(d)';
    controlUpdate(
      yaml,
      updates,
      'B_MULT',
      { expression: `${lineSense} * V(V_COMP) * ${g(kMult, 4)}` },
      'MULT',
      { gain: gNum(kMult, 4) },
    );
    const cOut = holdUpCap('C1');
    Object.assign(slot(updates, 'C1'), {
      capacitance: gNum(cOut, 3),
      ic: pyRound(vout, 1),
    });
    notes.push(
      `- Divider: $R_2 = R_3 (V_{out}/V_{ref} - 1) = ${g(r3, 4)}(${g(vout, 4)}/${g(vref, 3)} - 1)$`,
      `- Multiplier: $k = I_{pk} / (V_{pk} \\cdot 2.5) = ${g(iPk, 3)} / (${g(vpk, 4)} \\cdot 2.5) = ${g(kMult, 4)}$ per phase`,
    );
  } else if (topologyId === 'acdc_totem_pole_power_factor_correction') {
    Object.assign(slot(updates, 'VAC'), {
      amplitude: pyRound(vpk, 2),
      frequency: fLine,
    });
    slot(updates, 'R_LOAD').resistance = pyRound(rLoad, 3);
    const iPk = (2.0 * power) / vpk;
    controlUpdate(
      yaml,
      updates,
      'B_pol',
      { expression: 'V(n_AC_L, n_AC_N) >= 0 ? 1 : 0' },
      'POL',
    );
    controlUpdate(
      yaml,
      updates,
      'B_pol_sign',
      { expression: 'V(n_AC_L, n_AC_N) >= 0 ? 1 : -1' },
      'POL_SIGN',
    );
    controlUpdate(
      yaml,
      updates,
      'B_Verr',
      { expression: `${g(vout, 6)} - V(n_DC_POS)` },
      'REF_V',
      { value: gNum(vout, 6) },
    );
    controlUpdate(
      yaml,
      updates,
      'B_PI_out',
      {
        expression: `max(0, min(${g(1.6 * iPk, 4)}, V(n_Vp) + V(n_Vint)))`,
      },
      'LIM_PI',
      { upper: gNum(1.6 * iPk, 4) },
    );
    controlUpdate(
      yaml,
      updates,
      'B_Iref',
      {
        expression: `V(n_PI_out) * abs(V(n_AC_L, n_AC_N) / ${g(vpk, 6)})`,
      },
      'VAC_NORM',
      { expression: `abs(in1-in2)/${g(vpk, 6)}` },
    );
    controlUpdate(
      yaml,
      updates,
      'B_Duty',
      {
        expression: `1 - ( abs(V(n_AC_L, n_AC_N)) / ${g(vout, 6)} ) + (0.05 * V(n_Ierr))`,
      },
      'FF_D',
      { expression: `1-abs(in1-in2)/${g(vout, 6)}` },
    );
    controlUpdate(yaml, updates, 'C_Vint', { ic: pyRound(iPk, 3) }, 'INT_V', {
      ic: pyRound(iPk, 3),
    });
    const cOut = holdUpCap('Cout');
    Object.assign(slot(updates, 'Cout'), {
      capacitance: gNum(cOut, 3),
      ic: pyRound(vout, 2),
    });
    notes.push(
      `- Polarity detection: ternary comparators $V(n_{AC\\_L}, n_{AC\\_N}) \\ge 0 \\,? 1 : 0$ and $\\ge 0 \\,? 1 : -1$ (no $t=0$ shoot-through)`,
      `- Voltage loop target ${g(vout, 4)} V, line normalisation ${g(vpk, 4)} V, duty feed-forward $1 - |v_{line}|/V_{out}$`,
      `- Integrator pre-charge $I_{pk} = 2P/V_{pk} = ${g(iPk, 3)}\\,A$, limit $1.6 I_{pk}$`,
    );
  } else if (topologyId === 'acdc_flyback_pfc_dcm') {
    Object.assign(slot(updates, 'VAC'), {
      amplitude: pyRound(vpk, 2),
      frequency: fLine,
      phase: 90n,
    });
    slot(updates, 'R_LOAD').resistance = pyRound(rLoad, 3);
    const fsw = num(compParam(yaml, updates, 'PWM', 'frequency'), 1e5);
    let lm = num(
      compParam(yaml, updates, 'T1', ['Lm_primary', 'lm_primary', 'lm']),
      500e-6,
    );
    // Constant on-time DCM: line-averaged P_in = Vpk^2 * D^2 / (4 * Lm * fsw)
    const pIn = power / 0.92;
    let duty = Math.sqrt(4.0 * lm * fsw * pIn) / vpk;
    const dMax = 0.4;
    if (duty > dMax) {
      lm = (dMax * vpk) ** 2 / (4.0 * fsw * pIn);
      duty = dMax;
    }
    // Stay in DCM at the line peak: D + D_reset <= 0.85, D_reset = D * Vpk / V_or
    const vOr = (vpk * duty) / (0.85 - duty);
    const turns = (vout + 0.7) / vOr;
    Object.assign(slot(updates, 'PWM'), {
      duty_cycle: pyRound(duty, 5),
      frequency: fsw,
    });
    Object.assign(slot(updates, 'T1'), {
      Lm_primary: gNum(lm, 4),
      turns_ratio: pyRound(turns, 5),
    });
    slot(updates, 'D1').Bv = pyRound(1.5 * (vout + turns * vpk), 1);
    // Winding RC snubbers, realistic leakage (k = 0.985) and no diode
    // reverse-recovery charge carry ngspice through the line zero crossings.
    slot(updates, 'R_SNUB_P').resistance = 22.0;
    slot(updates, 'C_SNUB_P').capacitance = 2.2e-9;
    slot(updates, 'R_SNUB_S').resistance = 100.0;
    slot(updates, 'C_SNUB_S').capacitance = 1e-9;
    updates.T1.k_coupling = 0.985;
    for (const ref of ['DB1', 'DB2', 'DB3', 'DB4', 'D1'])
      slot(updates, ref).Tt = 0n;
    const cOut = holdUpCap('Cout', 0.04);
    Object.assign(slot(updates, 'Cout'), {
      capacitance: gNum(cOut, 3),
      ic: pyRound(vout, 2),
    });
    notes.push(
      `- DCM constant on-time: $D = \\sqrt{4 L_m f_{sw} P_{in}} / V_{pk} = ${fx(duty, 4)}$ with $L_m = ${g(lm * 1e6, 4)}\\,\\mu H$, $P_{in} = P_{out}/0.92$`,
      `- Reflected voltage $V_{or} = V_{pk} D / (0.85 - D) = ${g(vOr, 4)}\\,V$, $N_s/N_p = (V_{out} + 0.7)/V_{or} = ${g(turns, 4)}$`,
    );
  }
  return notes.join('\n');
}

/** `_adapt_single_phase_afe_parameters`; returns the reasoning markdown. */
export function adaptSinglePhaseAfe(
  yaml: Dict,
  updates: Updates,
  params: Dict | null,
): string {
  const [vinRms, vout, power, fLine] = singlePhaseOperatingPoint(
    params,
    [230.0, 400.0, 3000.0, 50.0],
  );
  const vpk = vinRms * Math.sqrt(2.0);
  const rLoad = power > 0 ? vout ** 2 / power : 53.33;
  const iPk = vinRms > 0 ? (Math.sqrt(2.0) * power) / vinRms : 18.45;
  const iMax = Math.max(40.0, pyRound(1.5 * iPk, 1));
  // Hold-up DC link for 2x line-frequency ripple (< 5 %)
  const cMin =
    vout > 0 && fLine > 0
      ? power / (4.0 * Math.PI * fLine * vout * (0.05 * vout))
      : 0.0022;
  const cDc = Math.max(0.0022, cMin);
  const bvReq = Math.max(800.0, pyRound(1.8 * vout, 1));

  slot(updates, 'GLOBAL_PARAMS').spice_line =
    `.param V_TARGET=${g(vout, 4)} V_PEAK=${g(vpk, 4)}`;
  Object.assign(slot(updates, 'VAC'), {
    amplitude: pyRound(vpk, 2),
    frequency: fLine,
  });
  slot(updates, 'R_DC').resistance = pyRound(rLoad, 2);
  Object.assign(slot(updates, 'C_DC'), { capacitance: gNum(cDc, 4), ic: vout });
  controlUpdate(
    yaml,
    updates,
    'B_ERR',
    { expression: 'V_TARGET - v(n_DC_BUS)' },
    'REF_V',
  );
  // Critically damped voltage loop: Kp 0.05, ki = G_INT / C_INT = 1 mA/V / 100 uF
  controlUpdate(
    yaml,
    updates,
    'B_P',
    { expression: 'v(n_err) * 0.05' },
    'KP_V',
    { gain: 0.05 },
  );
  controlUpdate(
    yaml,
    updates,
    'G_INT',
    { spice_line: 'G_INT 0 n_INT n_err 0 0.001' },
    'INT_V',
    { ki: 10.0, ic: gNum(iPk, 4) },
  );
  // Magnitude filter 2.2 uF: pole at ~72 Hz, away from the 3-15 Hz region
  controlUpdate(
    yaml,
    updates,
    'C_MAG_FLT',
    { capacitance: 2.2e-6 },
    'LPF_MAG',
    { ic: gNum(iPk, 4) },
  );
  controlUpdate(
    yaml,
    updates,
    'B_MAG',
    { expression: `min(max(v(n_P) + v(n_INT), 0), ${g(iMax, 4)})` },
    'LIM_MAG',
    { upper: gNum(iMax, 4) },
  );
  controlUpdate(
    yaml,
    updates,
    'B_REF',
    { expression: 'v(n_mag_flt) * v(n_VAC_P, n_VAC_N) / V_PEAK' },
    'REF_I',
  );
  slot(updates, 'IC_CMD').spice_line =
    `.ic V(n_DC_BUS)=${g(vout, 4)} V(n_INT)=${g(iPk, 4)} V(n_mag_flt)=${g(iPk, 4)}`;
  for (const d of ['D_A_TOP', 'D_A_BOT', 'D_B_TOP', 'D_B_BOT'])
    slot(updates, d).Bv = bvReq;

  return [
    '## Deterministic Single-Phase Active Front End (AFE) Parameter Sizing & Control Tuning',
    `- Line: $V_{in,rms} = ${g(vinRms, 4)}\\,\\text{V}$, $V_{pk} = \\sqrt{2} V_{in,rms} = ${g(vpk, 4)}\\,\\text{V}$, $f_{line} = ${g(fLine, 4)}\\,\\text{Hz}$`,
    `- Target Bus & Load: $V_{out} = ${g(vout, 4)}\\,\\text{V}$, $P_{out} = ${g(power, 4)}\\,\\text{W}$, $R_{DC} = V_{out}^2 / P_{out} = ${g(rLoad, 4)}\\,\\Omega$`,
    `- Peak AC Input Current: $I_{pk} = \\sqrt{2} P_{out} / V_{in,rms} = ${g(iPk, 4)}\\,\\text{A}$ (Limiter clamp $I_{max} = ${g(iMax, 4)}\\,\\text{A}$)`,
    '- Magnitude Filter ($C_{{MAG,FLT}} = 2.2\\,\\mu\\text{{F}}$): Shifts the outer loop filter pole to $f_c \\approx 72.3\\,\\text{{Hz}}$ (away from the critical 3–15 Hz delay region), restoring loop phase margin and eliminating hunting/drift.',
    `- Softened Voltage Loop PI Gains: $K_p = 0.05$ and $G_{INT} = 0.001\\,\\text{A/V}$ ($1\\,\\text{mA/V}$) to achieve critical damping and hold a steady ${g(vout, 4)} V bus.`,
    `- DC Link Capacitor: $C_{DC} = ${fx(cDc * 1e3, 2)}\\,\\text{mF}$ for $2 f_{line}$ ripple buffering.`,
    `- Initial Conditions: $.ic\\; V(n_{DC\\_BUS})=${g(vout, 4)}\\; V(n_{INT})=${g(iPk, 4)}\\; V(n_{mag\\_flt})=${g(iPk, 4)}$`,
  ].join('\n');
}

const DIODE_BRIDGE = new Set([
  'acdc_single_phase_diode_bridge',
  'single_phase_diode_bridge',
]);

const hasPin = (net: unknown[], ref: string, pin: string): boolean =>
  net.some(
    (p) => Array.isArray(p) && p.length === 2 && p[0] === ref && p[1] === pin,
  );

/** Adds the diode bridge's output capacitor `C_OUT` across `R_LOAD`. */
function addBridgeOutputCap(yaml: Dict, params: Dict): Dict {
  const comp: Dict = {
    ref: 'C_OUT',
    type: 'capacitor',
    role: 'output_filter',
    params,
  };
  if (!Array.isArray(yaml.components)) yaml.components = [];
  (yaml.components as unknown[]).push(comp);
  if (!Array.isArray(yaml.nets)) yaml.nets = [];
  for (const net of yaml.nets as unknown[]) {
    if (!Array.isArray(net)) continue;
    if (hasPin(net, 'R_LOAD', 'pos') && !hasPin(net, 'C_OUT', 'pos'))
      net.push(['C_OUT', 'pos']);
    if (hasPin(net, 'R_LOAD', 'neg') && !hasPin(net, 'C_OUT', 'neg'))
      net.push(['C_OUT', 'neg']);
  }
  return comp;
}

/** `_adapt_single_phase_diode_bridge`; returns the reasoning markdown. */
/**
 * Steady-state average output of a single-phase capacitor-input bridge
 * (|Vpk sin| - 2 Vf through R_LINE into C || R_LOAD), by time stepping.
 */
export function bridgeAverage(
  vpk: number,
  drop: number,
  rLine: number,
  rLoad: number,
  c: number,
  fLine: number,
): number {
  const period = 1 / fLine;
  const steps = 1000;
  const dt = period / steps;
  // Starts charged to the peak: settles within a few load time constants.
  const cycles = Math.min(50, Math.max(4, Math.ceil((5 * rLoad * c) / period)));
  let vc = Math.max(vpk - drop, 0);
  let sum = 0;
  let n = 0;
  for (let k = 0; k < cycles * steps; k += 1) {
    const t = k * dt;
    const vr = Math.abs(vpk * Math.sin(2 * Math.PI * fLine * t)) - drop;
    const i = vr > vc ? (vr - vc) / rLine : 0;
    // Exact-enough implicit step for a stiff (small C) cell.
    const g = 1 / rLoad + (i > 0 ? 1 / rLine : 0);
    const src = i > 0 ? vr / rLine : 0;
    vc = (vc * c + src * dt) / (c + g * dt);
    if (k >= (cycles - 2) * steps) {
      sum += vc;
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

export function adaptDiodeBridge(
  yaml: Dict,
  updates: Updates,
  paramsIn: Dict | null,
): string {
  const params = paramsIn ?? {};
  const hasCout = allComponents(yaml.components ?? []).some(
    ([c]) => c.ref === 'C_OUT' || c.id === 'C_OUT' || c.type === 'capacitor',
  );
  if (!hasCout) {
    addBridgeOutputCap(yaml, {
      capacitance: 0.00022,
      voltage_rating: 400.0,
      std_voltage_rating: 400.0,
    });
  }
  const [vinRms, vout, power, fLine] = singlePhaseOperatingPoint(
    params,
    [230.0, 207.0, 50.0, 50.0],
  );
  const vpk = vinRms * Math.sqrt(2.0);
  const rLoad = power > 0 ? vout ** 2 / power : 857.0;
  const iDc = vout > 0 ? power / vout : 0.24;
  Object.assign(slot(updates, 'VAC'), {
    amplitude: pyRound(vpk, 2),
    frequency: fLine,
    v_peak: pyRound(vpk, 2),
    v_rms: pyRound(vinRms, 2),
  });
  Object.assign(slot(updates, 'R_LOAD'), {
    resistance: pyRound(rLoad, 3),
    v_peak: pyRound(vpk, 2),
    v_rms: pyRound(vout, 2),
    i_rms: pyRound(iDc, 3),
  });
  const rLine = Math.max(0.1, Math.min(10.0, 0.01 * rLoad));
  slot(updates, 'R_LINE').resistance = pyRound(rLine, 2);
  const stdSemi = stdRating(vpk, STD_SEMI, 1.5);
  for (const d of ['D1', 'D2', 'D3', 'D4']) {
    Object.assign(slot(updates, d), {
      Bv: pyRound(1.5 * vpk, 1),
      std_voltage_rating: stdSemi,
      v_peak: pyRound(vpk, 2),
      v_rms: pyRound(vinRms, 2),
      i_peak: pyRound(iDc * Math.PI, 2),
      i_rms: pyRound(iDc * 1.11, 2),
    });
  }
  let ripple =
    extractNumericParam(params, [
      'ripple',
      'voltage ripple',
      'output voltage ripple',
      'vripple',
    ]) ?? 0.05;
  if (ripple && ripple > 0.5) ripple /= 100.0;
  if (!ripple || ripple <= 0) ripple = 0.05;
  ripple = Math.max(0.01, Math.min(0.2, ripple));
  const vripplePp = ripple * vout;
  let cout = power / (2.0 * fLine * vout * vripplePp);
  cout = Math.max(47.0e-6, Math.min(0.1, cout));
  // A capacitor-input bridge settles near the peak (~1.41 Vrms); an average
  // target below that (e.g. the unfiltered 0.9 Vrms) is only met with a
  // smaller capacitor. The bridge cannot regulate, so size C for the average.
  // Two conducting diodes of the template at the mean conduction current
  // (~pi/2 I_dc); a fixed 1.6 V put the 24 V -> 21 V output 3.8 % high.
  const bridgeDrop = 2 * diodeDrop(yaml, 'D1', (Math.PI / 2) * iDc);
  const avgAt = (c: number) =>
    bridgeAverage(vpk, bridgeDrop, rLine, rLoad, c, fLine);
  let filterNote = `target ripple ${fx(ripple * 100, 1)}%`;
  if (vout > 0 && avgAt(cout) > 1.02 * vout) {
    let lo = Math.log(1e-9);
    let hi = Math.log(cout);
    if (avgAt(1e-9) >= vout) hi = lo;
    else {
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (avgAt(Math.exp(mid)) > vout) hi = mid;
        else lo = mid;
      }
    }
    const full = avgAt(cout);
    cout = Math.exp(hi);
    filterNote =
      `reduced so the average output is ${g(vout, 4)} V: a ${g((power / (2.0 * fLine * vout * vripplePp)) * 1e6, 3)} µF ` +
      `filter would hold ${g(full, 4)} V (near the ${g(vpk, 4)} V peak); a diode bridge cannot regulate, so the ` +
      `requested average implies a large ripple (use a transformer or a regulator stage for a low-ripple ${g(vout, 4)} V)`;
  }
  const stdCap = stdRating(vpk, STD_PASSIVE, 1.2);
  Object.assign(slot(updates, 'C_OUT'), {
    capacitance: gNum(cout, 6),
    voltage_rating: stdCap,
    std_voltage_rating: stdCap,
    v_peak: pyRound(vpk, 2),
    i_rms: pyRound(iDc * 0.48, 2),
  });
  if (isDict(yaml.analysis)) {
    const reqs = getDict(yaml.analysis, 'transient').requirements ?? [];
    const tStop = Math.max(0.08, 4.0 / fLine);
    const tStart = tStop - 2.0 / fLine;
    for (const req of Array.isArray(reqs) ? reqs : []) {
      if (!isDict(req)) continue;
      for (const env of Array.isArray(req.environment) ? req.environment : []) {
        if (!isDict(env)) continue;
        env.t_stop = pyRound(tStop, 4);
        env.t_start = pyRound(tStart, 4);
        env.t_step = 1.0e-5;
        env.t_max_step = 1.0e-5;
      }
    }
  }
  return [
    '## Deterministic Single-Phase Diode Bridge Rectifier Sizing',
    `- AC Line Input: $V_{in,rms} = ${g(vinRms, 4)}\\,V$, $V_{pk} = \\sqrt{2} V_{in,rms} = ${g(vpk, 4)}\\,V$, $f_{line} = ${g(fLine, 4)}\\,Hz$`,
    `- DC Load: $R_{LOAD} = V_{out}^2 / P_{out} = ${g(vout, 4)}^2 / ${g(power, 4)} = ${g(rLoad, 4)}\\,\\Omega$ ($I_{dc} = ${g(iDc, 4)}\\,A$)`,
    `- Output Filter Capacitor: $C_{OUT} = ${fx(cout * 1e6, 3)}\\,\\mu F$ (rated ${pyStr(stdCap)} V, ${filterNote})`,
    `- Diodes D1..D4: $V_{RRM} \\ge 1.5 V_{pk} = ${fx(1.5 * vpk, 1)}\\,V$, std rating ${pyStr(stdSemi)} V`,
  ].join('\n');
}

/** Forward drop of the template rectifier diode at `i` (Shockley + Rs). */
function diodeDrop(yaml: Dict, ref: string, i: number): number {
  const is = num(compParam(yaml, {}, ref, 'Is'), 3.17e-5);
  const n = num(compParam(yaml, {}, ref, 'n'), 1.373);
  const rs = num(compParam(yaml, {}, ref, 'Rs'), 0.051);
  return n * 0.02585 * Math.log(Math.max(i, 1e-6) / is + 1) + rs * i;
}

/** Line-cycle transient window (as the diode bridge): 4 cycles, measured over the last 2. */
function lineCycleWindow(yaml: Dict, fLine: number): void {
  if (!isDict(yaml.analysis)) return;
  const reqs = getDict(yaml.analysis, 'transient').requirements ?? [];
  const tStop = Math.max(0.08, 4.0 / fLine);
  for (const req of Array.isArray(reqs) ? reqs : []) {
    if (!isDict(req)) continue;
    for (const env of Array.isArray(req.environment) ? req.environment : []) {
      if (!isDict(env)) continue;
      env.t_stop = pyRound(tStop, 4);
      env.t_start = pyRound(tStop - 2.0 / fLine, 4);
    }
  }
}

/**
 * Line-frequency transformer rectifiers, sized without the model (it mixed up
 * the turns-ratio convention and the filtered / unfiltered output: the
 * centre-tapped output came out at half the target, the full-wave one 5-60 %
 * high). The turns ratio is solved for the requested average output.
 *
 * - centre-tapped (`dual_ct_transformer` TX: each secondary half carries
 *   Ns/2 of the turns ratio), no output capacitor:
 *   Vavg = (2/pi) Vs,half,pk - Vf;
 * - full-wave (transformer + bridge) with C_OUT: capacitor-input average,
 *   C_OUT from the ripple target.
 */
function adaptTransformerRectifier(
  yaml: Dict,
  updates: Updates,
  paramsIn: Dict | null,
): string {
  const params = paramsIn ?? {};
  const centreTapped = lowerStr(yaml.id ?? '').includes('centre_tapped');
  const [vinRms, vout, power, fLine] = singlePhaseOperatingPoint(params, [
    24.0,
    centreTapped ? 13.0 : 18.0,
    15.0,
    50.0,
  ]);
  const vinPk = vinRms * Math.SQRT2;
  const rLoad = power > 0 ? vout ** 2 / power : 10.0;
  const iout = vout > 0 ? power / vout : 1.0;
  const iinRms = power / Math.max(vinRms, 1e-6) / 0.9;
  // Magnetizing current ~5 % of the input current at the line frequency.
  const lm = vinRms / (2 * Math.PI * fLine * 0.05 * Math.max(iinRms, 1e-3));
  Object.assign(slot(updates, 'VAC'), {
    amplitude: pyRound(vinPk, 3),
    frequency: fLine,
    v_peak: pyRound(vinPk, 2),
    v_rms: pyRound(vinRms, 2),
  });
  slot(updates, 'R_LOAD').resistance = pyRound(rLoad, 4);
  const lines = [
    `## Deterministic ${centreTapped ? 'Centre-Tapped' : 'Transformer'} Full-Wave Rectifier Sizing`,
    `- AC input $V_{rms} = ${g(vinRms, 4)}\\,V$ ($V_{pk} = ${g(vinPk, 4)}\\,V$), $f = ${g(fLine, 4)}\\,Hz$; load $R = V_{out}^2/P = ${g(rLoad, 4)}\\,\\Omega$ ($I_{out} = ${g(iout, 4)}\\,A$)`,
  ];
  let n: number;
  let vsPk: number;
  if (centreTapped) {
    // Each diode carries the full load current for half a cycle (peak ~ pi/2 Iout).
    const vf = diodeDrop(yaml, 'D1', (Math.PI / 2) * iout);
    const rIn = num(compParam(yaml, updates, 'R_IN', 'resistance'), 1.0);
    // R_IN reflected to a half winding, iterated with n.
    n = (2 * ((Math.PI / 2) * (vout + vf))) / vinPk;
    for (let k = 0; k < 4; k += 1) {
      const rRef = rIn * (n / 2) ** 2;
      vsPk = (Math.PI / 2) * (vout + vf) * ((rLoad + rRef) / rLoad);
      n = (2 * vsPk) / vinPk;
    }
    vsPk = (n / 2) * vinPk;
    lines.push(
      `- No output capacitor: $V_{avg} = \\frac{2}{\\pi} V_{s,half,pk} - V_f$ with $V_f = ${fx(vf, 2)}\\,V$ $\\Rightarrow V_{s,half,pk} = ${g(vsPk, 4)}\\,V$`,
      `- TX turns ratio (whole secondary / primary; each half carries half of it): $n = 2 V_{s,half,pk} / V_{pk} = ${fx(n, 4)}$`,
    );
  } else {
    const drop = 2 * diodeDrop(yaml, 'D1', 2 * iout);
    let ripple =
      extractNumericParam(params, [
        'ripple',
        'voltage ripple',
        'output voltage ripple',
      ]) ?? 0.05;
    if (ripple > 0.5) ripple /= 100.0;
    // At least 2 %: a 1 % target at 50 Hz asks for ~0.1 F, which a few line
    // cycles of simulation cannot charge.
    ripple = Math.max(0.02, Math.min(0.2, ripple || 0.05));
    let cout = power / (2.0 * fLine * vout * ripple * vout);
    cout = Math.max(47e-6, Math.min(0.1, cout));
    const rSer =
      num(compParam(yaml, updates, 'R_SEC', 'resistance'), 0.001) + 0.1;
    const avgAt = (nn: number) =>
      bridgeAverage(vinPk * nn, drop, rSer, rLoad, cout, fLine);
    let lo = 1e-3;
    let hi = 50;
    for (let k = 0; k < 40; k += 1) {
      const mid = Math.sqrt(lo * hi);
      if (avgAt(mid) > vout) hi = mid;
      else lo = mid;
    }
    n = Math.sqrt(lo * hi);
    vsPk = n * vinPk;
    Object.assign(slot(updates, 'C_OUT'), {
      capacitance: gNum(cout, 4),
      // Pre-charged to the output: the filter time constant (R_LOAD * C_OUT,
      // up to ~1 s) is far longer than the simulated line cycles.
      ic: pyRound(vout, 3),
      v_peak: pyRound(vsPk, 2),
      std_voltage_rating: stdRating(vsPk, STD_PASSIVE, 1.2),
    });
    lines.push(
      `- Output filter $C_{OUT} = P / (2 f V_{out} \\Delta V) = ${g(cout * 1e6, 4)}\\,\\mu F$ (ripple ${fx(ripple * 100, 1)} %); capacitor-input output $\\approx V_{s,pk} - 2V_f - \\Delta V/2$ with $2V_f = ${fx(drop, 2)}\\,V$`,
      `- TX turns ratio solved for the ${g(vout, 4)} V average: $n = ${fx(n, 4)}$ ($V_{s,pk} = ${g(vsPk, 4)}\\,V$)`,
    );
  }
  Object.assign(slot(updates, 'TX'), {
    turns_ratio: pyRound(n, 5),
    Lm_primary: gNum(lm, 3),
  });
  const vr = centreTapped ? 2 * vsPk : vsPk;
  for (const d of ['D1', 'D2', 'D3', 'D4']) {
    if (!hasComp(yaml, d)) continue;
    Object.assign(slot(updates, d), {
      Bv: pyRound(1.5 * vr, 1),
      std_voltage_rating: stdRating(vr, STD_SEMI, 1.5),
      v_peak: pyRound(vr, 2),
      i_peak: pyRound(iout * Math.PI, 2),
    });
  }
  lines.push(
    `- Magnetizing inductance $L_m = V_{rms} / (2\\pi f \\cdot 0.05 I_{in}) = ${g(lm, 3)}\\,H$; diodes block $${g(vr, 4)}\\,V$`,
  );
  lineCycleWindow(yaml, fLine);
  return lines.join('\n');
}

const INVERTER_POWER_KEYS = [
  'output power',
  'output_power',
  'rated power',
  'rated_power',
  'power',
  'pout',
];
const INVERTER_POWER_EXCLUDE = ['factor', 'loss', 'density', 'aux', 'supply'];
const INVERTER_FREQ_KEYS = [
  'output frequency',
  'output_frequency',
  'fundamental frequency',
  'line frequency',
  'ac frequency',
];
const INVERTER_VLL_EXCLUDE = [
  'range',
  'min',
  'max',
  'ripple',
  'thd',
  'regulation',
  'frequency',
  'current',
];

/**
 * `_adapt_three_phase_vsi`: SPWM references against the +/-10 V carrier carry
 * the modulation index (amplitude / carrier peak) and output frequency. Vout
 * is line-to-line RMS: V_ph,pk = V_LL sqrt(2/3), m = V_ph,pk / (Vdc/2) <= 1.
 */
function adaptVsi(yaml: Dict, updates: Updates, paramsIn: Dict | null): string {
  const params = paramsIn ?? {};
  const vdc =
    extractNumericParam(
      params,
      [
        'input voltage',
        'input_voltage',
        'dc link voltage',
        'dc bus voltage',
        'vin',
        'v_in',
        'vdc',
      ],
      ['range', 'min', 'max', 'ripple', 'current'],
    ) || num(compParam(yaml, updates, 'V5', 'voltage'), 380.0);
  const vll =
    extractNumericParam(
      params,
      [
        'output voltage',
        'output_voltage',
        'line-to-line voltage',
        'vout',
        'v_out',
        'ac output voltage',
      ],
      INVERTER_VLL_EXCLUDE,
    ) || vdc * 0.55;
  const power = extractNumericParam(
    params,
    INVERTER_POWER_KEYS,
    INVERTER_POWER_EXCLUDE,
  );
  let fOut = extractNumericParam(params, INVERTER_FREQ_KEYS);
  fOut = fOut && fOut >= 1.0 && fOut <= 1000.0 ? fOut : 50.0;
  const vPhPk = vll * Math.sqrt(2.0 / 3.0);
  const mReq = vPhPk / (vdc / 2.0);
  // With third-harmonic injection (V6, 1/6 of the reference at 3 f) the
  // reference peak is m * sqrt(3)/2, so m reaches 2/sqrt(3) = 1.155 linearly.
  const thirdHarmonic = hasComp(yaml, 'V6');
  const mMax = thirdHarmonic ? 2.0 / Math.sqrt(3.0) : 1.0;
  const m = Math.min(mReq, mMax);
  const triLine = pyStr(compParam(yaml, updates, 'V1', 'spice_line', ''));
  const tri = /PULSE\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)/i.exec(triLine);
  const carrierPk = tri
    ? Math.abs(toFloat(tri[2]))
    : Math.abs(num(compParam(yaml, updates, 'V1', 'v2'), 10.0));
  const amp = m * carrierPk;
  slot(updates, 'V5').voltage = vdc;
  // R13/R14 balance the DC link across C1/C2 (shunts: lowering them shorts it)
  for (const ref of ['R13', 'R14']) slot(updates, ref).resistance = 100e3;
  for (let k = 1; k <= 6; k++) slot(updates, `E${k}`).gain = 15n;
  // Gate drive: 50 ohm series, 50 kohm pull-down
  for (const k of [1, 3, 5, 7, 9, 11]) slot(updates, `R${k}`).resistance = 50.0;
  for (const k of [2, 4, 6, 8, 10, 12])
    slot(updates, `R${k}`).resistance = 50e3;
  const bvTarget = Math.max(600.0, vdc * 1.5);
  for (let k = 1; k <= 6; k++) slot(updates, `M${k}`).Bv = pyRound(bvTarget, 1);
  for (const [ref, node, phase] of [
    ['V2', 'ControlA', ''],
    ['V3', 'ControlB', ' 0 0 120'],
    ['V4', 'ControlC', ' 0 0 240'],
  ]) {
    if (hasComp(yaml, ref) && compParam(yaml, {}, ref, 'spice_line') === null) {
      // Library form: a sine source (its phase kept), not a raw SINE() line
      Object.assign(slot(updates, ref), {
        amplitude: gNum(amp, 4),
        frequency: fOut,
      });
    } else {
      slot(updates, ref).spice_line =
        `${ref} ${node} 0 SINE(0 ${g(amp, 4)} ${g(fOut, 6)}${phase})`;
    }
  }
  if (thirdHarmonic) {
    Object.assign(slot(updates, 'V6'), {
      amplitude: gNum(amp / 6.0, 4),
      frequency: 3.0 * fOut,
    });
  }
  const notes = [
    '## Deterministic SPWM modulation',
    `- $V_{ph,pk} = V_{LL} \\sqrt{2/3} = ${g(vll, 4)} \\cdot 0.8165 = ${g(vPhPk, 4)}\\,V$`,
    `- $m = V_{ph,pk} / (V_{dc}/2) = ${g(vPhPk, 4)} / ${g(vdc / 2, 4)} = ${fx(mReq, 3)}$` +
      (mReq > mMax
        ? thirdHarmonic
          ? ` (capped at ${fx(mMax, 3)}: the DC link is too low for this output even with third-harmonic injection; expect $V_{LL} \\approx 0.707 V_{dc}$)`
          : ' (capped at 1.0: the DC link is too low for this output in linear SPWM; expect $V_{LL} \\approx 0.612 V_{dc}$)'
        : ''),
    `- Reference amplitude $${g(amp, 3)}\\,V$ against the $\\pm${g(carrierPk, 3)}\\,V$ carrier at $f_{out} = ${g(fOut, 4)}\\,Hz$`,
    ...(thirdHarmonic
      ? [
          `- Third-harmonic injection V6: $${g(amp / 6.0, 3)}\\,V$ at $${g(3.0 * fOut, 4)}\\,Hz$ (reference peak $${g(amp * 0.866, 3)}\\,V$, linear up to $m = 1.155$)`,
        ]
      : []),
  ];
  if (power) {
    const vPhRms =
      Math.min(vll, (thirdHarmonic ? 0.707 : 0.612) * vdc) / Math.sqrt(3.0);
    const rPh = vPhRms ** 2 / (power / 3.0);
    for (const ref of ['R15', 'R16', 'R17'])
      slot(updates, ref).resistance = pyRound(rPh, 4);
    notes.push(
      `- Load per phase $R = V_{ph,rms}^2 / (P/3) = ${g(vPhRms, 4)}^2 / ${g(power / 3, 4)} = ${g(rPh, 4)}\\,\\Omega$`,
    );
  }
  return notes.join('\n');
}

/**
 * `_adapt_three_phase_vienna`: grid amplitude and current-reference
 * normalisation (phase peak), bus target, current limit, pre-charge, load.
 * The input voltage is the grid line-to-line RMS value.
 */
function adaptVienna(
  yaml: Dict,
  updates: Updates,
  paramsIn: Dict | null,
): string {
  const params = paramsIn ?? {};
  const vinLl =
    extractNumericParam(
      params,
      [
        'input voltage',
        'input_voltage',
        'grid voltage',
        'line voltage',
        'vin',
        'v_in',
        'ac input voltage',
      ],
      ['range', 'min', 'max', 'ripple', 'current', 'frequency'],
    ) || 208.0;
  const vout =
    extractNumericParam(
      params,
      [
        'output voltage',
        'output_voltage',
        'dc bus voltage',
        'dc_bus',
        'vout',
        'v_out',
      ],
      ['range', 'min', 'max', 'ripple', 'regulation', 'current'],
    ) || 800.0;
  const power =
    extractNumericParam(
      params,
      ['output power', 'output_power', 'rated power', 'power', 'pout'],
      INVERTER_POWER_EXCLUDE,
    ) || 15000.0;
  let fLine = extractNumericParam(params, [
    'input frequency',
    'line frequency',
    'grid frequency',
    'ac frequency',
  ]);
  fLine = fLine && fLine >= 40.0 && fLine <= 440.0 ? fLine : 50.0;
  const vpk = (vinLl / Math.sqrt(3.0)) * Math.sqrt(2.0);
  const iPk = (2.0 * power) / (3.0 * vpk * 0.97);
  const rLoad = vout ** 2 / power;
  for (const ph of ['A', 'B', 'C']) {
    const lower = ph.toLowerCase();
    Object.assign(slot(updates, `V_AC_${ph}`), {
      amplitude: pyRound(vpk, 2),
      frequency: fLine,
    });
    controlUpdate(
      yaml,
      updates,
      `B_Iref_${ph}`,
      { expression: `V(i_mag) * abs(V(v_${lower}_grid)) / ${g(vpk, 6)}` },
      `REF_${ph}`,
      { gain: `1/${g(vpk, 6)}` },
    );
    // The block feed-forward divides by the measured bus: nothing to scale
    controlUpdate(
      yaml,
      updates,
      `B_Duty_${ph}`,
      {
        expression: `1 - (abs(V(v_${lower}_grid))/${g(vout / 2, 6)}) + 0.01*(V(i_ref_${ph}) - V(i_act_${ph}))`,
      },
      `FF_${ph}`,
    );
  }
  controlUpdate(
    yaml,
    updates,
    'B_VERR',
    { expression: `${g(vout, 6)} - V(v_dc_tot)` },
    'REF_V',
    { value: gNum(vout, 6) },
  );
  controlUpdate(
    yaml,
    updates,
    'B_IMAG',
    { expression: `max(0, min(${g(1.6 * iPk, 4)}, V(v_p) + V(v_int)))` },
    'LIM_PI',
    { upper: gNum(1.6 * iPk, 4) },
  );
  controlUpdate(yaml, updates, 'C_VINT', { ic: pyRound(iPk, 3) }, 'INT_V', {
    ic: pyRound(iPk, 3),
    upper: gNum(1.6 * iPk, 4),
  });
  slot(updates, 'C_DC_TOP').ic = pyRound(vout / 2.0, 2);
  slot(updates, 'C_DC_BOT').ic = pyRound(-vout / 2.0, 2);
  slot(updates, 'R_LOAD').resistance = pyRound(rLoad, 3);
  return [
    '## Deterministic Vienna control scaling',
    `- $V_{pk} = V_{LL} \\sqrt{2/3} = ${g(vpk, 4)}\\,V$ (grid amplitude and current-reference normalisation)`,
    `- DC bus target ${g(vout, 4)} V, duty feed-forward $1 - |v_{ph}| / (V_{out}/2)$ with $V_{out}/2 = ${g(vout / 2, 4)}\\,V$`,
    `- $I_{pk} = 2P / (3 V_{pk} \\eta) = ${g(iPk, 3)}\\,A$ (integrator pre-charge, limit $1.6 I_{pk}$); $R_{LOAD} = ${g(rLoad, 4)}\\,\\Omega$`,
  ].join('\n');
}

/** `_three_phase_inverter_spec`: (Vdc, V_LL rms, Pout, f_out). */
function threePhaseInverterSpec(
  paramsIn: Dict | null,
  vdcDefault: number,
): [number, number, number | null, number] {
  const params = paramsIn ?? {};
  const vdc =
    extractNumericParam(
      params,
      [
        'voltage_in',
        'input voltage',
        'input_voltage',
        'dc link voltage',
        'dc bus voltage',
        'vin',
        'v_in',
        'vdc',
      ],
      ['range', 'min', 'max', 'ripple', 'current'],
    ) || vdcDefault;
  const vll =
    extractNumericParam(
      params,
      [
        'voltage_out',
        'output voltage',
        'output_voltage',
        'line-to-line voltage',
        'vout',
        'v_out',
        'ac output voltage',
      ],
      INVERTER_VLL_EXCLUDE,
    ) || 0.55 * vdc;
  const power = extractNumericParam(
    params,
    INVERTER_POWER_KEYS,
    INVERTER_POWER_EXCLUDE,
  );
  const fOut = extractNumericParam(params, INVERTER_FREQ_KEYS);
  return [vdc, vll, power, fOut && fOut >= 1.0 && fOut <= 1000.0 ? fOut : 50.0];
}

/**
 * `_adapt_npc_inverter`: three-phase 3L-NPC; each phase leg regulates
 * V_LL / sqrt(3) with feed-forward normalised to Vdc/2.
 */
function adaptNpc(yaml: Dict, updates: Updates, params: Dict | null): string {
  const [vdc, vll, power, fOut] = threePhaseInverterSpec(params, 800.0);
  const half = vdc / 2.0;
  const vPhRms = vll / Math.sqrt(3.0);
  const vPhPk = vPhRms * Math.sqrt(2.0);
  const vRef = Math.min(vPhPk, 0.95 * half);
  for (const ref of ['VDC_TOP', 'VDC_BOT']) slot(updates, ref).voltage = half;
  for (const ref of ['C1', 'C2'])
    if (hasTopLevel(yaml, ref)) slot(updates, ref).ic = half;
  const loadR = power ? vPhRms ** 2 / (power / 3.0) : 0;
  if (hasTopLevel(yaml, 'V_ref_a')) {
    for (const [ph, shift] of [
      ['a', 0.0],
      ['b', -120.0],
      ['c', -240.0],
    ] as const) {
      Object.assign(slot(updates, `V_ref_${ph}`), {
        amplitude: pyRound(vRef, 2),
        frequency: fOut,
        delay: 0n,
        damping: 0n,
        phase: shift,
      });
      controlUpdate(
        yaml,
        updates,
        `B_ctrl_${ph}`,
        {
          expression: `(V(n_err_${ph})*2.0 + V(n_pi_int_${ph}) + V(n_ref_target_${ph}))/${g(half, 6)}`,
        },
        `K_NORM_${ph}`,
        { gain: `1/${g(half, 6)}` },
      );
      if (power) slot(updates, `R_LOAD_${ph}`).resistance = pyRound(loadR, 4);
    }
  } else {
    Object.assign(slot(updates, 'V_ref_target'), {
      amplitude: pyRound(vRef, 2),
      frequency: fOut,
    });
    controlUpdate(
      yaml,
      updates,
      'B_ctrl',
      {
        expression: `(V(n_err)*2.0 + V(n_pi_int) + V(n_ref_target))/${g(half, 6)}`,
      },
      'K_NORM',
      { gain: `1/${g(half, 6)}` },
    );
    if (power) slot(updates, 'R_LOAD').resistance = pyRound(loadR, 4);
  }
  const notes = [
    '## Deterministic 3-Phase NPC control scaling',
    `- $V_{ph,pk} = V_{LL} \\sqrt{2/3} = ${g(vPhPk, 4)}\\,V$ against $V_{dc}/2 = ${g(half, 4)}\\,V$ (m = ${fx(vPhPk / half, 3)})` +
      (vPhPk > 0.95 * half
        ? ' - beyond the bus, reference capped at $0.95 V_{dc}/2$'
        : ''),
    `- Feed-forward normalisation $V_{dc}/2 = ${g(half, 4)}\\,V$, output frequency ${g(fOut, 4)} Hz`,
    '- Phase displacement: Phase A (0°), Phase B (-120°), Phase C (-240°)',
  ];
  if (power) {
    notes.push(
      `- Per-phase load $R = V_{ph,rms}^2 / (P/3) = ${g(loadR, 4)}\\,\\Omega$ (Total $P = ${g(power, 4)}\\,W$)`,
    );
  }
  return notes.join('\n');
}

/**
 * `_adapt_t_type_inverter`: feed-forward + proportional current control into
 * a star R-L load; load, current reference and feed-forward follow from V_LL,
 * P and the load inductance (carrier +/-10 V: modulation gain (Vdc/2)/10).
 */
export function adaptTType(
  yaml: Dict,
  updates: Updates,
  params: Dict | null,
): string {
  const [vdc, vll, powerIn, fOut] = threePhaseInverterSpec(params, 800.0);
  const half = vdc / 2.0;
  const vPhRms = vll / Math.sqrt(3.0);
  const power = powerIn || (3.0 * vPhRms ** 2) / 10.0;
  const r = vPhRms ** 2 / (power / 3.0);
  let lLoad = num(compParam(yaml, updates, 'L1', 'inductance'), 1e-3);
  // keep the load mostly resistive
  lLoad = Math.min(lLoad, (0.1 * r) / (2 * Math.PI * fOut));
  const xl = 2 * Math.PI * fOut * lLoad;
  const z = Math.hypot(r, xl);
  const phi = (180.0 / Math.PI) * Math.atan2(xl, r);
  const iPk = (vPhRms * Math.sqrt(2.0)) / z;
  const vAcPk = iPk * z;
  // A 1/6 third harmonic in series with each feed-forward (V_VFF3_*) lowers
  // the peak of the sum to sqrt(3)/2 of the fundamental.
  const thirdHarmonic = hasComp(yaml, 'V_VFF3_A');
  const vFfMax = thirdHarmonic ? (9.5 * 2.0) / Math.sqrt(3.0) : 9.5;
  const vFf = Math.min((vAcPk * 10.0) / half, vFfMax);
  slot(updates, 'VIN').voltage = vdc;
  for (const ref of ['R15', 'R16', 'R17'])
    slot(updates, ref).resistance = pyRound(r, 4);
  for (const ref of ['L1', 'L2', 'L3'])
    slot(updates, ref).inductance = gNum(lLoad, 4);
  for (const [ph, shift] of [
    ['A', 0.0],
    ['B', -120.0],
    ['C', -240.0],
  ] as const) {
    Object.assign(slot(updates, `V_IREF_${ph}`), {
      amplitude: pyRound(iPk, 4),
      frequency: fOut,
      phase: shift,
    });
    Object.assign(slot(updates, `V_VFF_${ph}`), {
      amplitude: pyRound(vFf, 4),
      frequency: fOut,
      phase: pyRound(shift + phi, 3),
    });
    if (thirdHarmonic)
      Object.assign(slot(updates, `V_VFF3_${ph}`), {
        amplitude: pyRound(vFf / 6.0, 4),
        frequency: 3 * fOut,
        phase: pyRound((((3 * (shift + phi)) % 360) + 360) % 360, 3),
      });
  }
  // Split DC-link capacitors sized for power and midpoint stability
  const cDc = power >= 40000 ? '2200u' : power >= 15000 ? '1000u' : '470u';
  for (const ref of ['C1', 'C2']) {
    if (hasTopLevel(yaml, ref)) {
      slot(updates, ref).capacitance = cDc;
      slot(updates, ref).ic = half;
    }
  }
  // 100 nF / 10 ohm RC snubbers damp the dv/dt transients
  for (const ref of ['C_SNUB_A', 'C_SNUB_B', 'C_SNUB_C'])
    slot(updates, ref).capacitance = '100n';
  for (const ref of ['R_SNUB_A', 'R_SNUB_B', 'R_SNUB_C'])
    slot(updates, ref).resistance = 10n;
  slot(updates, 'SPICE_SETTINGS').ic = `v(N008)=${g(half, 6)}`;
  return [
    '## Deterministic T-type control scaling',
    `- Load per phase $R = V_{ph,rms}^2/(P/3) = ${g(r, 4)}\\,\\Omega$, $L = ${g(lLoad * 1e3, 4)}\\,mH$, $|Z| = ${g(z, 4)}\\,\\Omega$, $\\phi = ${g(phi, 3)}^\\circ$`,
    `- $I_{pk} = \\sqrt{2} V_{ph,rms} / |Z| = ${g(iPk, 4)}\\,A$`,
    `- Feed-forward $V_{FF} = V_{ac,pk} \\cdot 10 / (V_{dc}/2) = ${g(vFf, 4)}\\,V$` +
      ((vAcPk * 10.0) / half > vFfMax
        ? ` (capped at ${g(vFfMax, 4)}: the bus is too low for this output)`
        : ''),
    ...(thirdHarmonic
      ? [
          `- Third-harmonic injection $V_{FF}/6 = ${g(vFf / 6.0, 4)}\\,V$ at $3 f_{out} = ${g(3 * fOut, 4)}\\,Hz$ (the load star floats, so it drives no current; linear up to $V_{LL} = 0.707\\,V_{dc}$)`,
        ]
      : []),
    `- DC-link capacitors $C_1 = C_2 = ${cDc}$ with midpoint bias $V(N008) = ${g(half, 4)}\\,V$`,
    '- Snubbers scaled to $C_{{snub}} = 100\\,nF$, $R_{{snub}} = 10\\,\\Omega$ for dv/dt damping and numerical stability',
  ].join('\n');
}

/** Topologies whose control loops are scaled deterministically. */
const DETERMINISTIC_CONTROL = new Set([
  ...PFC_TOPOLOGIES,
  'acdc_three_phase_vienna',
  'acdc_three_phase_active_front_end',
  'acdc_single_phase_active_front_end',
  'dcac_neutral_point_clamped',
  'dcac_t_type',
  'dcac_three_phase_voltage_source_inverter',
]);

const UNSUPPORTED_BSOURCE_FUNCS = /\b(if|ifelse|limit|step|sign)\s*\(/i;

/**
 * `_drop_unsafe_control_updates`: model edits to behavioural sources that use
 * functions ngspice lacks are dropped; with `keepNone` every model edit to
 * the control (sources and, beyond chat-first, control blocks) is dropped.
 */
function dropUnsafeControlUpdates(
  yaml: Dict,
  updates: Updates,
  keepNone: boolean,
): void {
  const controlRefs = new Set<unknown>();
  for (const [comp] of allComponents(yaml.components ?? [])) {
    if (
      ['b_source', 'e_source', 'g_source'].includes(comp.type as string) ||
      (keepNone && isControlBlock(comp.type))
    )
      controlRefs.add(or(comp.ref, comp.id));
  }
  for (const ref of Object.keys(updates)) {
    if (!controlRefs.has(ref) || !isDict(updates[ref])) continue;
    if (keepNone) {
      delete updates[ref];
      continue;
    }
    const expr = updates[ref].expression;
    if (typeof expr === 'string' && UNSUPPORTED_BSOURCE_FUNCS.test(expr)) {
      delete updates[ref].expression;
      if (Object.keys(updates[ref]).length === 0) delete updates[ref];
    }
  }
}

/**
 * `_sync_interleaved_buck_pwms`: phase k's high side PWM(2k+1) starts at
 * k*T/N; its low side PWM(2k+2) is the complement with `deadTime` on both
 * edges (the model produced overlapping pulses on the later phases).
 */
export function syncInterleavedBuckPwms(
  yaml: Dict,
  updates: Updates,
  deadTime = 40e-9,
): void {
  const pwmParams = new Map<number, Dict>();
  for (const [comp] of allComponents(yaml.components ?? [])) {
    const ref = pyStr(or(comp.ref, ''));
    if (ref.startsWith('PWM') && /^\d+$/.test(ref.slice(3))) {
      const p = or(comp.params, {});
      pwmParams.set(Number(ref.slice(3)), isDict(p) ? p : {});
    }
  }
  const nPhases = Math.floor(pwmParams.size / 2);
  if (nPhases < 1) return;
  const first: Dict = {
    ...(pwmParams.get(1) ?? {}),
    ...(isDict(updates.PWM1) ? updates.PWM1 : {}),
  };
  let freq: number;
  let duty: number;
  try {
    freq = f(or(first.frequency, 500e3));
    duty = f(or(first.duty_cycle, 0.12));
  } catch (error) {
    if (error instanceof PyError) return;
    throw error;
  }
  const period = 1.0 / freq;
  duty = Math.min(Math.max(duty, 0.02), 0.9);
  const lsDuty = Math.max(1.0 - duty - (2.0 * deadTime) / period, 0.0);
  for (let k = 0; k < nPhases; k++) {
    const offset = (k * period) / nPhases;
    Object.assign(slot(updates, `PWM${2 * k + 1}`), {
      frequency: freq,
      duty_cycle: pyRound(duty, 6),
      tdelay: pyRound(offset, 12),
      vlow: 0n,
      vhigh: 12n,
    });
    Object.assign(slot(updates, `PWM${2 * k + 2}`), {
      frequency: freq,
      duty_cycle: pyRound(lsDuty, 6),
      tdelay: pyRound(offset + duty * period + deadTime, 12),
      vlow: 0n,
      vhigh: 12n,
    });
  }
}

/** `sanitize_fsbb_negative_vout`. */
export function sanitizeFsbbNegativeVout(
  paramsIn: Dict,
  absVout: number,
): Dict {
  const params = structuredClone(paramsIn);
  const strip = (s: string) => s.replace(/-\s*([\d.]+)/g, '$1');
  for (const [key, val] of Object.entries(params)) {
    if (VOUT_KEYS.some((k) => key.toLowerCase().includes(k))) {
      if (isNum(val)) params[key] = absVout;
      else if (typeof val === 'string') params[key] = strip(val);
    }
  }
  const fix = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!isDict(p)) continue;
      const name = pyStr(p.name ?? '').toLowerCase();
      if (['output voltage', 'vout', 'v_out'].some((kw) => name.includes(kw))) {
        p.value = strip(pyStr(p.value ?? ''));
      }
    }
  };
  fix(params.derivedParametersList);
  if (isDict(params.specification))
    fix(params.specification.derivedParametersList);
  return params;
}

export const isFsbb = (topId: string): boolean =>
  ['dcdc_four_switch_buck_boost', 'four_switch_buck_boost'].includes(topId) ||
  topId.includes('four_switch') ||
  topId.includes('fsbb');

// --- components ------------------------------------------------------------------

/** `_iter_all_components`: [component, parent ref]. */
export function allComponents(components: unknown): Array<[Dict, unknown]> {
  const out: Array<[Dict, unknown]> = [];
  const walk = (list: unknown, parent: unknown, depth: number) => {
    if (depth > 12 || !Array.isArray(list)) return;
    for (const comp of list) {
      if (!isDict(comp)) continue;
      out.push([comp, parent]);
      if (Array.isArray(comp.internal))
        walk(comp.internal, comp.ref ?? null, depth + 1);
    }
  };
  walk(components, null, 0);
  return out;
}

const PROMPT_TOKENS = [
  '_INT',
  '_FLT',
  '_CP',
  '_DAMP',
  '_REF',
  '_TRI',
  '_PW',
  '_ERR',
  '_CERR',
  '_MAG',
  'BB_',
  'PWM',
  'B_P',
  'B_SENSE',
  'R_IACT',
  'R_RAW_DUMMY',
  'R_DC_A',
  'R_DC_B',
  'R_DC_C',
];

function hiddenFromPrompt(ref: unknown): boolean {
  if (!truthy(ref)) return true;
  const up = pyStr(ref).toUpperCase();
  if (['R_ISO', 'R_ISO_S1', 'R_ISO_S2', 'C_WW', 'CWW', 'GND'].includes(up))
    return true;
  if (up.startsWith('V_IREF') || up.startsWith('V_VFF')) return false;
  if (PROMPT_TOKENS.some((t) => up.includes(t))) return true;
  return up.startsWith('B') && up.length <= 3 && /^\d+$/.test(up.slice(1));
}

/** `", ".join(f"{k}={v}")` with Python str() of each value. */
const paramText = (params: Dict): string =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${pyStr(v)}`)
    .join(', ');

/** The user message of the sizing call. */
export function buildUserPrompt(yaml: Dict, params: Dict): string {
  const lines: string[] = [];
  for (const [comp, parent] of allComponents(yaml.components ?? [])) {
    const ref = or(or(comp.ref, comp.id), comp.id ?? '?');
    const ctype = comp.type ?? '?';
    if (['b_source', 'e_source', 'g_source'].includes(ctype as string))
      continue;
    if (hiddenFromPrompt(ref)) continue;
    const role = comp.role ?? '?';
    let p = or(comp.params, comp.parameters ?? {});
    if (!isDict(p)) p = {};
    const location = truthy(parent) ? ` [inside ${pyStr(parent)}]` : '';
    lines.push(
      `  - ${pyStr(ref)} (${pyStr(ctype)}, ${pyStr(role)})${location}: ${paramText(p as Dict)}`,
    );
  }
  const nets = yaml.nets ?? [];
  const netsSummary = truthy(nets) ? yamlDumpFlow(nets) : '(none)';
  const fsbbNote = isFsbb(lowerStr(yaml.id ?? ''))
    ? '\nNOTE FOR FOUR-SWITCH BUCK-BOOST: This topology is strictly non-inverting. All target voltages and calculations are for the positive magnitude |Vout|.\n'
    : '';
  return `
USER CONSTRAINTS:
${jsonDumpsIndent(params)}

TOPOLOGY: ${pyStr(yaml.id ?? 'unknown')} — ${pyStr(yaml.name ?? 'unknown')}
DESCRIPTION: ${pyStr(yaml.description ?? 'N/A')}
${fsbbNote}
COMPONENTS (ref, type, role, current params):
(Components tagged "[inside <parent_ref>]" are sub-components nested within a parent
part such as a transformer — e.g. snubber resistors/capacitors. You MAY optimise them:
address each by its own ref as a top-level key in your JSON, exactly like any other
component.)
${lines.join('\n')}

NETLIST CONNECTIONS:
${netsSummary}

Based on the user constraints above, calculate the optimal component parameter values.
For all power semiconductors (MOSFETs, Diodes) and passive components (Capacitors, Inductors), you MUST provide a \`std_voltage_rating\` parameter. You must include a 15% to 20% safety margin above the absolute worst-case peak voltage (including Ldi/dt spikes and ringing).
CRITICAL: You MUST choose this \`std_voltage_rating\` ONLY from the following explicit lists of standard commercial ratings. Do not interpolate or invent values.
- For Power Semiconductors (MOSFETs/Diodes/IGBTs): [20, 30, 40, 60, 80, 100, 150, 200, 250, 400, 500, 600, 650, 800, 900, 1000, 1200, 1700, 3300]
- For Capacitors: [6.3, 10, 16, 25, 35, 50, 63, 100, 160, 200, 250, 350, 400, 450, 500, 630, 800, 1000]

Return ONLY a JSON object containing _reasoning and components keys as specified in the rules.
`;
}

// --- model reply ------------------------------------------------------------------

const KEY_NORMALIZATION: Record<string, string> = {
  bv: 'Bv',
  ibv: 'Ibv',
  vdrop: 'v_drop',
  v_drop: 'v_drop',
  kp: 'Kp',
  is: 'Is',
  cjo: 'Cjo',
  tt: 'Tt',
  delay: 'tdelay',
};

const asDict = (d: unknown): Dict => {
  if (!isDict(d))
    throw new PyError('AttributeError', "object has no attribute 'get'");
  return d;
};
/** Python `dict.get(k, d)` then `float(...)`. */
const fget = (d: unknown, key: string, dflt: number): number => {
  const dict = asDict(d);
  return f(key in dict ? dict[key] : dflt);
};
/** Python `float(d.get(k) or dflt)`. */
const forget = (d: unknown, key: string, dflt: number): number =>
  f(or(asDict(d)[key], dflt));

/**
 * Full-bridge centre-tapped, open loop: Vout = 2 D n Vin - (Vf + I R_path).
 * n covers the rectifier / conduction drop (~0.8 V + 6 mOhm * Iout,
 * measured); Lm keeps the magnetizing current under 10 % of the reflected
 * load current so it does not pump extra energy into the output.
 */
function sizeCenterTappedTransformer(
  yaml: Dict,
  updates: Updates,
  params: Dict,
  d1: number,
  freq: number,
): void {
  const vin = num(compParam(yaml, updates, 'VIN', 'voltage'), 0.0);
  const vout = Math.abs(extractVoutFromParams(params) ?? 0.0);
  const rLoad = num(compParam(yaml, updates, 'R_LOAD', 'resistance'), 0.0);
  if (!(vin > 0 && vout > 0 && d1 > 0)) return;
  const iout = rLoad > 0 ? vout / rLoad : 0.0;
  const n = (vout + 0.8 + 0.006 * iout) / (2.0 * d1 * vin);
  const t1 = slot(updates, 'T1');
  t1.turns_ratio = pyRound(n, 5);
  if (iout > 0) {
    const lmMin = (vin * d1) / (freq * 0.1 * iout * n);
    const lmNow = num(
      compParam(yaml, updates, 'T1', ['Lm_primary', 'lm_primary']),
      0.0,
    );
    if (lmNow < lmMin) t1.Lm_primary = gNum(lmMin, 3);
  }
}

/** PWM synchronisation rules core enforces on the model's PWM settings. */
export function enforcePwmRules(
  yaml: Dict,
  updates: Updates,
  params: Dict,
): void {
  const topologyId = yaml.id;
  if (!('PWM1' in updates)) return;
  const pwm = (ref: string) => slot(updates, ref);
  const set = (
    refs: string[],
    duty: number,
    delay: number | bigint,
    freq: number,
  ) => {
    for (const ref of refs) {
      Object.assign(pwm(ref), {
        duty_cycle: duty,
        tdelay: delay,
        frequency: freq,
      });
    }
  };
  if (topologyId === 'dcdc_two_switch_forward' && 'PWM2' in updates) {
    updates.PWM2.duty_cycle =
      'duty_cycle' in updates.PWM1 ? updates.PWM1.duty_cycle : 0.4;
    updates.PWM2.tdelay = 0n;
    updates.PWM2.phase_shift = 0n;
  } else if (topologyId === 'dcdc_four_switch_buck_boost') {
    const d1 = fget(updates.PWM1, 'duty_cycle', 0.5);
    const freq = forget(updates.PWM1, 'frequency', 200e3);
    const delay2 = pyRound(d1 * (1.0 / freq), 9);
    const d2 = pyRound(1.0 - d1, 6);
    set(['PWM1', 'PWM4'], d1, 0n, freq);
    set(['PWM2', 'PWM3'], d2, delay2, freq);
  } else if (
    ['dcdc_full_bridge_llc_resonant', 'dcdc_full_bridge_centertapped'].includes(
      topologyId as string,
    )
  ) {
    const d1 = fget(updates.PWM1, 'duty_cycle', 0.45);
    const freq = forget(updates.PWM1, 'frequency', 100e3);
    const delay2 = pyRound(0.5 * (1.0 / freq), 9);
    set(['PWM1', 'PWM4'], d1, 0n, freq);
    set(['PWM2', 'PWM3'], d1, delay2, freq);
    if (topologyId === 'dcdc_full_bridge_centertapped')
      sizeCenterTappedTransformer(yaml, updates, params, d1, freq);
  } else if (
    [
      'dcdc_push_pull',
      'dcdc_half_bridge',
      'dcdc_half_bridge_llc_resonant',
      'dcdc_llc_resonant',
    ].includes(topologyId as string)
  ) {
    const d1 = fget(updates.PWM1, 'duty_cycle', 0.45);
    const freq = forget(updates.PWM1, 'frequency', 100e3);
    const delay2 = pyRound(0.5 * (1.0 / freq), 9);
    set(['PWM1'], d1, 0n, freq);
    set(['PWM2'], d1, delay2, freq);
  } else if (topologyId === 'dcdc_cllc_resonant') {
    const d1 = fget(getDict(updates, 'PWM1'), 'duty_cycle', 0.45);
    const freq = forget(getDict(updates, 'PWM1'), 'frequency', 100e3);
    const delay2 = pyRound(0.5 * (1.0 / freq), 9);
    set(['PWM1', 'PWM4', 'PWM6', 'PWM7'], d1, 0n, freq);
    set(['PWM2', 'PWM3', 'PWM5', 'PWM8'], d1, delay2, freq);
  } else if ('PWM2' in updates) {
    const d1 = fget(updates.PWM1, 'duty_cycle', 0);
    const freq = f(
      or(
        or(asDict(updates.PWM1).frequency, asDict(updates.PWM2).frequency),
        200e3,
      ),
    );
    if (d1 > 0 && freq > 0) {
      const dt = 100e-9;
      const period = 1.0 / freq;
      const d2 = 1.0 - d1 - (2.0 * dt) / period;
      updates.PWM2.duty_cycle = pyRound(d2, 6);
      updates.PWM2.tdelay = pyRound(d1 * period + dt, 9);
    }
  }
}

export interface SizingOutcome {
  /** Model / adapter updates (`{}`: keep the template values). */
  updates: Updates;
  reasoning: string | null;
  /** The (mutated) YAML to build the decks from. */
  yaml: Dict;
}

/** L, C and the side of T1 each tank is on (sets the load it sees). */
const RESONANT_TANKS: Record<
  string,
  Array<[string, string, 'primary' | 'secondary']>
> = {
  dcdc_cllc_resonant: [
    ['Lr', 'Cr_P', 'primary'],
    ['Ls', 'Cr_S', 'secondary'],
  ],
  dcdc_half_bridge_llc_resonant: [['Lr', 'Cr', 'primary']],
  dcdc_full_bridge_llc_resonant: [['Lr', 'Cr', 'primary']],
};

/** Q a resonant tank is moved towards when its L-C product is repaired. */
const TANK_Q = 0.4;

/** Resistance of the template's `role: load` resistor. */
function loadResistance(yaml: Dict, updates: Updates): number | null {
  for (const [comp] of allComponents(yaml.components ?? [])) {
    if (lowerStr(comp.type) !== 'resistor' || lowerStr(comp.role) !== 'load')
      continue;
    const ref = pyStr(or(comp.ref, comp.id));
    const r = parseEngToNum(compParam(yaml, updates, ref, 'resistance'));
    return r && r > 0 ? r : null;
  }
  return null;
}

/**
 * Resonant tank check on the model's reply: each L-C tank must resonate at the
 * switching frequency (the model's arithmetic was off by 10x in L*C for the
 * 400 -> 800 V CLLC: fr = 317 kHz at fsw = 100 kHz, output 84 V instead of
 * 800 V). When fr is more than 15 % away from fsw, the tank is moved to fsw by
 * keeping L, keeping C or keeping sqrt(L / C), whichever leaves its Q
 * (sqrt(L / C) over the reflected AC load 8 R / (pi^2 n^2)) closest to 0.4:
 * which part the model got wrong differs (keeping L turned an 800 V / 50 kW
 * tank into Q = 3.3, 527 V instead of 800 V; keeping sqrt(L / C) turned
 * another reply into a 0.5 uH tank). Without a load or turns ratio, L is kept.
 */
function adaptResonantTank(yaml: Dict, updates: Updates): string {
  const tanks = RESONANT_TANKS[lowerStr(yaml.id ?? '')] ?? [];
  const fsw = parseEngToNum(compParam(yaml, updates, 'PWM1', 'frequency'));
  if (!fsw || fsw <= 0) return '';
  const w = 2 * Math.PI * fsw;
  const rLoad = loadResistance(yaml, updates);
  const n = parseEngToNum(compParam(yaml, updates, 'T1', 'turns_ratio'));
  const notes: string[] = [];
  for (const [lRef, cRef, side] of tanks) {
    const l = parseEngToNum(compParam(yaml, updates, lRef, 'inductance'));
    const c = parseEngToNum(compParam(yaml, updates, cRef, 'capacitance'));
    if (!l || !c || l <= 0 || c <= 0) continue;
    const fr = 1 / (2 * Math.PI * Math.sqrt(l * c));
    if (Math.abs(fr / fsw - 1) <= 0.15) continue;
    const rac =
      rLoad && n && n > 0
        ? (8 / Math.PI ** 2) * (side === 'primary' ? rLoad / n ** 2 : rLoad)
        : null;
    const options: Array<[string, number]> = [
      [`kept ${lRef}`, w * l],
      [`kept ${cRef}`, 1 / (w * c)],
      ['kept $Z_0 = \\sqrt{L/C}$', Math.sqrt(l / c)],
    ];
    const miss = (z0: number) =>
      rac ? Math.abs(Math.log(z0 / rac / TANK_Q)) : 0;
    const [how, z0] = options.reduce((best, o) =>
      miss(o[1]) < miss(best[1]) ? o : best,
    );
    const lNew = gNum(z0 / w, 4);
    const cNew = gNum(1 / (w * z0), 4);
    if (lNew !== l) slot(updates, lRef).inductance = lNew;
    if (cNew !== c) slot(updates, cRef).capacitance = cNew;
    notes.push(
      `- ${lRef}-${cRef} resonated at ${g(fr / 1e3, 4)} kHz, not at $f_{sw} = ${g(fsw / 1e3, 4)}\\,kHz$: ${how}${rac ? ` (Q = ${g(z0 / rac, 3)} against the reflected load ${g(rac, 4)} Ω)` : ''}; ${lRef} = ${g(lNew * 1e6, 4)} µH, ${cRef} = ${g(cNew * 1e9, 4)} nF`,
    );
  }
  return notes.length ? ['## Resonant tank check', ...notes].join('\n') : '';
}

/** Control scaling run on the model's reply, by topology id. */
const REPLY_ADAPTERS: Array<
  [(id: string) => boolean, (y: Dict, u: Updates, p: Dict) => string]
> = [
  [(id) => PFC_TOPOLOGIES.has(id), adaptSinglePhasePfc],
  [(id) => id === 'dcac_three_phase_voltage_source_inverter', adaptVsi],
  [(id) => id === 'acdc_three_phase_vienna', adaptVienna],
  [(id) => id === 'dcac_neutral_point_clamped', adaptNpc],
  [(id) => id in RESONANT_TANKS, (y, u) => adaptResonantTank(y, u)],
];

/**
 * Everything after the model call (core `optimize_topology_parameters`):
 * parse, normalise keys, enforce PWM rules, run the control-scaling adapters
 * and apply the updates. `template` is an untouched copy of the YAML.
 */
export function processReply(
  text: string,
  yaml: Dict,
  template: Dict,
  params: Dict,
): SizingOutcome {
  const raw = text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const json =
    start !== -1 && end !== -1 && end >= start
      ? raw.slice(start, end + 1)
      : raw;
  let parsed: unknown;
  try {
    parsed = jsonLoadsPy(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      updates: {},
      reasoning: `LLM parsing failed: ${message}. Output was truncated or invalid.`,
      yaml: structuredClone(template),
    };
  }
  try {
    const root = asDict(parsed);
    let reasoning: unknown =
      '_reasoning' in root ? root._reasoning : 'No AI reasoning provided.';
    const components = asDict('components' in root ? root.components : {});
    const updates: Updates = {};
    for (const [ref, value] of Object.entries(components)) {
      if (isDict(value)) {
        const normalized: Dict = {};
        for (const [k, v] of Object.entries(value)) {
          normalized[KEY_NORMALIZATION[k.toLowerCase()] ?? k] = v;
        }
        updates[ref] = normalized;
      } else updates[ref] = value as Dict;
    }
    enforcePwmRules(yaml, updates, params);
    const id = typeof yaml.id === 'string' ? yaml.id : '';
    dropUnsafeControlUpdates(yaml, updates, DETERMINISTIC_CONTROL.has(id));
    if (id === 'dcdc_interleaved_multiphase_buck')
      syncInterleavedBuckPwms(yaml, updates);
    const adapter = REPLY_ADAPTERS.find(([matches]) => matches(id));
    if (adapter)
      reasoning = `${pyStr(reasoning)}

${adapter[1](yaml, updates, params)}`;
    const text2 =
      reasoning === null || reasoning === undefined ? null : pyStr(reasoning);
    if (Object.keys(updates).length === 0) {
      return { updates, reasoning: text2, yaml: structuredClone(template) };
    }
    applyUpdatesToYaml(yaml, updates, params);
    return { updates, reasoning: text2, yaml };
  } catch {
    // core: any other failure keeps the template
    return { updates: {}, reasoning: null, yaml: structuredClone(template) };
  }
}

/** Topologies sized without the model (core checks them before any call). */
const DETERMINISTIC_SIZING: Array<
  [string[], (y: Dict, u: Updates, p: Dict) => string]
> = [
  [['dcdc_dual_active_bridge', 'dual_active_bridge', 'dab'], adaptDab],
  [['dcac_t_type', 't_type_multilevel_inverter'], adaptTType],
  [
    [
      'acdc_three_phase_active_front_end',
      'three_phase_active_front_end',
      'three_phase_afe',
    ],
    adaptAfe,
  ],
  [
    [
      'acdc_single_phase_active_front_end',
      'single_phase_active_front_end',
      'single_phase_afe',
    ],
    adaptSinglePhaseAfe,
  ],
  [[...DIODE_BRIDGE], adaptDiodeBridge],
  [
    [
      'acdc_centre_tapped_full_wave',
      'acdc_single_phase_full_wave(transformer)',
    ],
    adaptTransformerRectifier,
  ],
];

/**
 * The deterministic part before any model call. Returns the outcome for the
 * topologies core sizes without the model, else the prompt inputs.
 */
export function prepareSizing(
  template: Dict,
  paramsIn: Dict,
): { outcome: SizingOutcome } | { yaml: Dict; params: Dict; user: string } {
  let params = paramsIn;
  if (isFsbb(lowerStr(template.id ?? ''))) {
    const vout = extractVoutFromParams(params);
    if (vout !== null && vout < 0)
      params = sanitizeFsbbNegativeVout(params, Math.abs(vout));
  }
  const yaml = structuredClone(template);
  const topId = lowerStr(yaml.id ?? '');
  const adapter = DETERMINISTIC_SIZING.find(([ids]) => ids.includes(topId));
  if (adapter) {
    const updates: Updates = {};
    const reasoning = adapter[1](yaml, updates, params);
    applyUpdatesToYaml(yaml, updates, params);
    return { outcome: { updates, reasoning, yaml } };
  }
  return { yaml, params, user: buildUserPrompt(yaml, params) };
}

// --- applying updates ------------------------------------------------------------------

const BANNED_KEYS = new Set([
  'constraint',
  'constraints',
  'note',
  'notes',
  'comment',
  'comments',
  'description',
  'reason',
  'reasoning',
  'unit',
  'units',
  '_reasoning',
]);

/** `apply_parameter_updates_to_yaml(yaml_dict, updates, custom_params)`. */
export function applyUpdatesToYaml(
  yaml: Dict,
  updates: Updates,
  params: Dict | null,
): number {
  // Keyed by the raw ref: an int ref never matches a (string) update key.
  const byRef = new Map<unknown, Dict[]>();
  for (const [comp] of allComponents(yaml.components ?? [])) {
    const ref = or(comp.ref, comp.id);
    if (ref === null || ref === undefined) continue;
    const list = byRef.get(ref) ?? [];
    list.push(comp);
    byRef.set(ref, list);
  }
  let applied = 0;
  for (const [ref, newParams] of Object.entries(updates)) {
    if (ref === 'SPICE_SETTINGS') {
      if (isDict(yaml.analysis)) {
        const targets = [
          yaml.analysis.spice_settings,
          isDict(yaml.analysis.transient)
            ? yaml.analysis.transient.spice_settings
            : undefined,
        ];
        for (const settings of targets) {
          if (!isDict(settings)) continue;
          for (const [k, v] of Object.entries(
            isDict(newParams) ? newParams : {},
          )) {
            if (k === 'ic' || k === 'options') settings[k] = v;
          }
        }
        applied += 1;
      }
      continue;
    }
    let targets = byRef.get(ref);
    if (
      !targets &&
      ['C_OUT', 'COUT'].includes(ref.toUpperCase()) &&
      DIODE_BRIDGE.has(lowerStr(yaml.id ?? ''))
    ) {
      targets = [addBridgeOutputCap(yaml, {})];
      byRef.set('C_OUT', targets);
    }
    if (!targets || !isDict(newParams) || Object.keys(newParams).length === 0)
      continue;
    for (const comp of targets) {
      const hasParameters = 'parameters' in comp;
      let p = hasParameters ? comp.parameters : comp.params;
      if (!isDict(p)) {
        p = {};
        if ('id' in comp && !('ref' in comp)) comp.parameters = p;
        else comp.params = p;
      }
      for (const [k, v] of Object.entries(newParams)) {
        if (!BANNED_KEYS.has(k.toLowerCase())) (p as Dict)[k] = v;
      }
    }
    applied += 1;
  }

  let vout = params ? extractVoutFromParams(params) : null;
  if (isFsbb(lowerStr(yaml.id ?? '')) && vout !== null && vout < 0)
    vout = Math.abs(vout);
  if (vout && isDict(yaml.analysis)) {
    for (const kind of ['transient', 'dc', 'ac']) {
      const section = yaml.analysis[kind] ?? {};
      if (!isDict(section) || !Array.isArray(section.requirements)) continue;
      for (const req of section.requirements) {
        const criteria =
          isDict(req) && isDict(req.criteria) ? req.criteria : null;
        if (criteria && 'target_vout' in criteria) criteria.target_vout = vout;
        // Single-phase inverter: the output target is an RMS value.
        if (criteria && 'target_vout_rms' in criteria)
          criteria.target_vout_rms = Math.abs(vout);
      }
    }
  }
  return applied;
}

// --- change list ------------------------------------------------------------------

const CHANGE_PARAMS = new Set([
  'voltage',
  'frequency',
  'inductance',
  'lm_primary',
  'capacitance',
  'resistance',
  'duty_cycle',
  'phase_shift',
  'tdelay',
  'delay',
  'turns_ratio',
  'modulation_index',
  'modulation',
  'bv',
  'std_voltage_rating',
  'v_drop',
  'vdrop',
  'v_peak',
  'v_rms',
  'i_peak',
  'i_rms',
  'i_ripple',
  'delta_i',
  'i_ripple_pri',
  'i_ripple_sec',
  'np',
  'ns',
  'turns_pri',
  'turns_sec',
  'part_number',
  'rds_on',
  'cost',
  'technology',
  'tr',
  'tf',
  'expression',
  'spice_line',
  'ic',
  'amplitude',
  'v1',
  'v2',
]);

function hiddenFromTable(ref: string): boolean {
  if (!ref) return true;
  const up = ref.toUpperCase();
  if (['R_ISO', 'R_ISO_S1', 'R_ISO_S2', 'C_WW', 'Cww'].includes(up))
    return true;
  return PROMPT_TOKENS.some((t) => up.includes(t));
}

export interface ChangeRow {
  ref: string;
  param: string;
  before: unknown;
  after: unknown;
}

/** `build_parameter_change_list(original, updates, custom_params)`. */
export function buildChangeList(
  original: Dict,
  updates: Updates,
  params: Dict | null,
): ChangeRow[] {
  const orig = new Map<string, Dict>();
  for (const [comp] of allComponents(original.components ?? [])) {
    const ref = or(comp.ref, comp.id);
    if (!truthy(ref)) continue;
    const p = or(comp.params, comp.parameters ?? {});
    orig.set(pyStr(ref), isDict(p) ? p : {});
  }
  const merged = new Map<string, Dict>();
  for (const [ref, p] of orig) merged.set(ref, { ...p });
  for (const [ref, p] of Object.entries(updates)) {
    if (!isDict(p)) continue;
    if (!merged.has(ref)) merged.set(ref, {});
    Object.assign(merged.get(ref)!, p);
  }
  const changes: ChangeRow[] = [];
  for (const [ref, p] of merged) {
    if (hiddenFromTable(ref)) continue;
    for (const [param, after] of Object.entries(p)) {
      if (!CHANGE_PARAMS.has(param.toLowerCase())) continue;
      const before = orig.get(ref)?.[param];
      changes.push({
        ref,
        param,
        before: before === undefined ? null : before,
        after,
      });
    }
  }
  let tv: unknown;
  try {
    tv =
      params && Object.keys(params).length
        ? extractVoutFromParams(params)
        : null;
  } catch {
    return changes; // core printed the error and skipped the VOUT row
  }
  if (tv === null) {
    const analysis = getDict(original, 'analysis');
    outer: for (const kind of ['transient', 'dc', 'ac']) {
      const reqs = getDict(analysis, kind).requirements ?? [];
      for (const req of Array.isArray(reqs) ? reqs : []) {
        const v = getDict(req, 'criteria').target_vout;
        if (v !== undefined && v !== null) {
          tv = v;
          break outer;
        }
      }
    }
  }
  if (tv !== null && tv !== undefined) {
    changes.splice(1, 0, {
      ref: 'VOUT',
      param: 'target_voltage',
      before: null,
      after: tv,
    });
  }
  return changes;
}

// --- quick params line ------------------------------------------------------------------

const TEMPLATES: Array<[string, string]> = [
  [
    'buck',
    'Vin=24  Vout=5  fsw=100k  L1=47u  C1=220u  R1=5  Kp=0.1  Ki=100  Kd=0',
  ],
  [
    'synchronous_buck',
    'Vin=24  Vout=5  fsw=100k  L1=47u  C1=220u  R1=5  Kp=0.1  Ki=100  Kd=0',
  ],
  [
    'boost',
    'Vin=24  Vout=36  fsw=100k  L1=330u  C1=100u  R_load=20  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'buck_boost',
    'Vin=24  Vout=5  fsw=100k  L1=100u  C1=100u  R1=10  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'four_switch_buck_boost',
    'Vin=24  Vout=12  fsw=100k  L1=47u  C1=220u  R1=5  Kp=0.1  Ki=100  Kd=0',
  ],
  [
    'flyback',
    'Vin=24  Vout=12  fsw=100k  Np=100  Ns=50  C1=1000u  R_load=4  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'forward',
    'Vin=48  Vout=12  fsw=100k  Np=100  Ns=75  L1=1m  C1=470u  R_load=2  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'sepic',
    'Vin=24  Vout=12  fsw=100k  L1=1m  L2=1m  C1=100u  C2=10u  C3=100u  R1=10  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'cuk',
    'Vin=24  Vout=-12  fsw=100k  L1=100u  L2=100u  C1=100u  C2=100u  R1=10  Kp=0.1  Ki=60  Kd=0',
  ],
  [
    'full_bridge',
    'Vin=48  Vout=12  fsw=100k  Np=80  Ns=20  L1=47u  C1=220u  R1=5',
  ],
  [
    'half_bridge',
    'Vin=48  Vout=12  fsw=100k  Np=80  Ns=20  L1=47u  C1=220u  R1=5',
  ],
  [
    'dual_active_bridge',
    'Vin=400  Vout=400  Pout=10k  fsw=70k  LLk=19u  R_LOAD=16  C_OUT=47u  Kp=0.001  Ki=1.33u',
  ],
  [
    'dcdc_dual_active_bridge',
    'Vin=400  Vout=400  Pout=10k  fsw=70k  LLk=19u  R_LOAD=16  C_OUT=47u  Kp=0.001  Ki=1.33u',
  ],
  [
    'three_phase_active_front_end',
    'Vin=380  Vout=700  Pout=10k  fsw=20k  LA=5m  C_DC=2200u  R_DC=49  Kp=0.08  Ki=5m',
  ],
  [
    'acdc_three_phase_active_front_end',
    'Vin=380  Vout=700  Pout=10k  fsw=20k  LA=5m  C_DC=2200u  R_DC=49  Kp=0.08  Ki=5m',
  ],
  [
    'single_phase_diode_bridge',
    'Vin=230  Vout=207  Pout=50  f_line=50  C_OUT=220u  R_LOAD=857',
  ],
  [
    'acdc_single_phase_diode_bridge',
    'Vin=230  Vout=207  Pout=50  f_line=50  C_OUT=220u  R_LOAD=857',
  ],
  ['default', 'Vin=24  Vout=5  fsw=100k  L1=47u  C1=220u  R1=5'],
];

const UNIT_SUFFIX = /(?:Ω|ohm|ohms|h|f|hz|v)$/i;

/** `parse_eng_to_num`. */
export function parseEngToNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (isNum(val)) return f(val);
  const s = pyStr(val)
    .trim()
    .replace(/[\u00B5\u03BC]/g, 'u')
    .replace(UNIT_SUFFIX, '')
    .trim();
  const m = /^([+-]?[\d.]+)\s*([pnumkM])?$/.exec(s);
  if (m) {
    const base = floatOfMatch(m[1]);
    const mult: Record<string, number> = {
      p: 1e-12,
      n: 1e-9,
      u: 1e-6,
      m: 1e-3,
      k: 1e3,
      M: 1e6,
    };
    return m[2] ? base * mult[m[2]] : base;
  }
  try {
    return toFloat(s);
  } catch {
    return null;
  }
}

const trimZeros = (text: string): string =>
  text.replace(/0+$/, '').replace(/\.$/, '');

/** `format_eng_val`. */
export function formatEngVal(val: unknown, unit = ''): string {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'string') {
    const cleaned = val
      .trim()
      .replace(/[\u00B5\u03BC]/g, 'u')
      .replace(UNIT_SUFFIX, '')
      .trim();
    if (/^[+-]?[\d.]+\s*[pnumkM]$/.test(cleaned)) return `${cleaned}${unit}`;
  }
  const num = parseEngToNum(val);
  if (num === null) return pyStr(val);
  if (num === 0) return `0${unit}`;
  const a = Math.abs(num);
  if (a >= 1e6) return `${trimZeros(fx(num / 1e6, 2))}M${unit}`;
  if (a >= 1e3) return `${trimZeros(fx(num / 1e3, 2))}k${unit}`;
  if (a >= 1) return trimZeros(a >= 10 ? fx(num, 1) : fx(num, 2)) + unit;
  if (a >= 1e-3) return `${trimZeros(fx(num * 1e3, 2))}m${unit}`;
  if (a >= 1e-6) return `${trimZeros(fx(num * 1e6, 2))}u${unit}`;
  if (a >= 1e-9) return `${trimZeros(fx(num * 1e9, 2))}n${unit}`;
  if (a >= 1e-12) return `${trimZeros(fx(num * 1e12, 2))}p${unit}`;
  return `${formatE(num, 2)}${unit}`;
}

const RATING_PARAMS = new Set([
  'v_peak',
  'v_rms',
  'i_peak',
  'i_rms',
  'i_ripple',
  'delta_i',
  'voltage_rating',
  'current_rating',
  'power_rating',
  'rds_on',
  'part_number',
  'cost',
  'technology',
  'tr',
  'tf',
  'bv',
  'v_drop',
  'vdrop',
  'series_resistance',
  'esr',
  'dcr',
]);

/** `build_quick_params_line(topology, custom_params, recalculated)`. */
export function buildQuickParamsLine(
  topology: string,
  paramsIn: Dict | null,
  rows: ChangeRow[],
): string {
  const norm = topology
    .toLowerCase()
    .trim()
    .replace(/-/g, '_')
    .replace(/ /g, '_');
  let template = TEMPLATES[TEMPLATES.length - 1][1];
  for (const [k, tpl] of TEMPLATES) {
    if (norm.includes(k)) {
      template = tpl;
      break;
    }
  }
  const tokens = new Map<string, string>();
  for (const m of template.matchAll(/([a-zA-Z0-9_.-]+)\s*[:=]\s*([^\s,;]+)/g)) {
    tokens.set(m[1].trim(), m[2].trim());
  }
  const params = paramsIn ?? {};
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (truthy(params[k])) return params[k];
    return keys.length ? params[keys[keys.length - 1]] : undefined;
  };
  const vin = pick('vin', 'input_voltage', 'inputVoltage', 'v_in');
  if (vin !== null && vin !== undefined) tokens.set('Vin', formatEngVal(vin));
  const vout = pick('vout', 'output_voltage', 'outputVoltage', 'v_out');
  if (vout !== null && vout !== undefined)
    tokens.set('Vout', formatEngVal(vout));
  const fsw = pick(
    'fsw',
    'switching_frequency',
    'frequency',
    'switchingFrequency',
  );
  if (fsw !== null && fsw !== undefined) tokens.set('fsw', formatEngVal(fsw));
  const pout = pick('pout', 'power', 'output_power');
  const iout = pick('iout', 'output_current', 'current');
  if (vout !== null && vout !== undefined) {
    try {
      const v = toFloat(vout);
      if (pout !== null && pout !== undefined) {
        const p = toFloat(pout);
        if (p > 0) tokens.set('R1', formatEngVal((v * v) / p));
      } else if (iout !== null && iout !== undefined) {
        const i = toFloat(iout);
        if (i > 0) tokens.set('R1', formatEngVal(v / i));
      }
    } catch (error) {
      if (
        !(error instanceof PyError) ||
        (error.pyType !== 'ValueError' && error.pyType !== 'TypeError')
      )
        throw error;
    }
  }
  for (const item of rows) {
    const ref = pyStr(item.ref ?? '').toUpperCase();
    const param = pyStr(item.param ?? '').toLowerCase();
    const val = item.after;
    if (val === null || val === undefined || val === '') continue;
    if (RATING_PARAMS.has(param)) continue;
    if (
      ['inductance', 'lm_primary', 'l'].includes(param) ||
      (ref.startsWith('L') && ['value', 'l'].includes(param))
    ) {
      tokens.set(ref === 'L2' ? 'L2' : 'L1', formatEngVal(val));
    } else if (
      ['capacitance', 'c'].includes(param) ||
      ((ref.startsWith('C') || ref === 'COUT') &&
        ['value', 'c'].includes(param))
    ) {
      tokens.set(ref === 'C2' ? 'C2' : 'C1', formatEngVal(val));
    } else if (
      ['resistance', 'r'].includes(param) ||
      ((ref.startsWith('R') || ref.includes('LOAD')) &&
        ['value', 'r'].includes(param))
    ) {
      tokens.set('R1', formatEngVal(val));
    } else if (
      ['voltage', 'v', 'value'].includes(param) &&
      (['VIN', 'V1', 'V_IN'].includes(ref) || ref.includes('VIN'))
    ) {
      tokens.set('Vin', formatEngVal(val));
    } else if (
      ['voltage', 'target_vout', 'v', 'value'].includes(param) &&
      ['VOUT', 'V_OUT', 'CONST1', 'REF', 'V_SET'].includes(ref)
    ) {
      tokens.set('Vout', formatEngVal(val));
    } else if (
      ['frequency', 'fsw'].includes(param) ||
      ((['PWM', 'FSW'].includes(ref) || ref.includes('TRI')) &&
        ['frequency', 'fsw', 'value'].includes(param))
    ) {
      tokens.set('fsw', formatEngVal(val));
    } else if (['duty_cycle', 'duty'].includes(param))
      tokens.set('duty', pyStr(val));
    else if (['turns_ratio', 'turnsratio'].includes(param))
      tokens.set('turnsRatio', pyStr(val));
    else if (['np', 'turns_pri'].includes(param)) tokens.set('Np', pyStr(val));
    else if (['ns', 'turns_sec'].includes(param)) tokens.set('Ns', pyStr(val));
    else if (param === 'kp') tokens.set('Kp', pyStr(val));
    else if (param === 'ki') tokens.set('Ki', pyStr(val));
    else if (param === 'kd') tokens.set('Kd', pyStr(val));
  }
  const out: string[] = [];
  for (const k of [
    'Vin',
    'Vout',
    'fsw',
    'L1',
    'C1',
    'R1',
    'Kp',
    'Ki',
    'Kd',
    'Np',
    'Ns',
    'duty',
  ]) {
    if (tokens.has(k)) {
      out.push(`${k}=${tokens.get(k)}`);
      tokens.delete(k);
    }
  }
  for (const [k, v] of tokens) out.push(`${k}=${v}`);
  return out.join('  ');
}
