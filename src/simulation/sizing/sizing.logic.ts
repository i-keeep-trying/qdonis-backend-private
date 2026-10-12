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

function cleanVal(raw: unknown): number | null {
  if (isNum(raw)) return f(raw);
  if (typeof raw !== 'string') return null;
  const m = /[-+]?[\d.]+/.exec(raw);
  if (!m) return null;
  let val = floatOfMatch(m[0]);
  const s = raw.toLowerCase();
  if (
    s.includes('kw') ||
    s.includes('khz') ||
    raw.includes('k') ||
    raw.includes('K')
  )
    val *= 1e3;
  else if (s.includes('meg') || s.includes('mhz')) val *= 1e6;
  else if (s.includes('u') || s.includes('µ')) val *= 1e-6;
  else if (
    s.includes('m') &&
    (s.includes('ma') || s.includes('mv') || s.includes('ms'))
  )
    val *= 1e-3;
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
          out.formula = `(abs([Vout_avg])**2) / ${floatRepr(pyRound(rLoad, 4))}`;
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

/** `_adapt_three_phase_afe_parameters`; returns the reasoning markdown. */
export function adaptAfe(
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
        'line_voltage',
        'grid_voltage',
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
        'phase',
      ],
    ) ?? 380.0;
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

  for (const v of ['V_A', 'V_B', 'V_C'])
    slot(updates, v).amplitude = pyRound(vPhasePk, 2);
  slot(updates, 'R_DC').resistance = pyRound(rLoad, 2);
  const cDc = power >= 5000.0 ? 2200e-6 : 1500e-6;
  slot(updates, 'C_DC').capacitance = cDc;
  slot(updates, 'B_ERR').expression = `${g(vout, 4)} - v(V_DC)`;
  slot(updates, 'B_INT').expression =
    `v(V_I) >= ${iMaxText} ? (v(V_ERR) > 0 ? 0 : 0.005 * v(V_ERR)) : (v(V_I) <= 0 ? (v(V_ERR) < 0 ? 0 : 0.005 * v(V_ERR)) : 0.005 * v(V_ERR))`;
  slot(updates, 'C_INT').capacitance = 10e-6;
  slot(updates, 'B_VERR_RAW').expression =
    `((v(V_ERR) * 0.08) + v(V_I)) > ${iMaxText} ? ${iMaxText} : (((v(V_ERR) * 0.08) + v(V_I)) < 0 ? 0 : ((v(V_ERR) * 0.08) + v(V_I)))`;
  for (const ph of ['A', 'B', 'C']) {
    slot(updates, `B_REF${ph}`).expression =
      `v(I_MAG) * (v(V_${ph}_node) - v(N_star)) / ${fx(vPhasePk, 2)}`;
    slot(updates, `B_ERR_${ph}`).expression =
      `((v(I_REF_${ph}) - v(V_IACT_${ph})) * 20) > 12 ? 12 : (((v(I_REF_${ph}) - v(V_IACT_${ph})) * 20) < -12 ? -12 : ((v(I_REF_${ph}) - v(V_IACT_${ph})) * 20))`;
  }
  for (const [ph, top, bot] of [
    ['A', 'B1', 'B4'],
    ['B', 'B2', 'B5'],
    ['C', 'B3', 'B6'],
  ]) {
    slot(updates, top).expression =
      `7.5 * (1 + tanh(5 * (v(V_TRI) - 0.2 - v(V_CTRL_${ph}))))`;
    slot(updates, bot).expression =
      `7.5 * (1 + tanh(5 * (v(V_CTRL_${ph}) - v(V_TRI) - 0.2)))`;
  }
  const bv = Math.max(1200.0, pyRound(1.5 * vout, 1));
  for (const d of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
    Object.assign(slot(updates, d), {
      Bv: bv,
      Rs: 0.001,
      Tt: 10e-9,
      Cjo: 50e-12,
    });
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
      ss.use_ic = false;
      ss.method = 'trap';
      ss.trtol = 7n;
      ss.ic = `v(V_DC)=${g(vout, 4)} v(V_I)=${fx(iPhasePk, 2)}`;
      for (const req of Array.isArray(trans.requirements)
        ? trans.requirements
        : []) {
        if (!isDict(req)) continue;
        if (!isDict(req.criteria)) req.criteria = {};
        (req.criteria as Dict).target_vout = vout;
        (req.criteria as Dict).tolerance_pct = 5.0;
        for (const out of Array.isArray(req.outputs) ? req.outputs : []) {
          if (isDict(out) && out.var === 'vout_avg_v') {
            out.description = `Regulated DC Output Voltage (${g(vout, 4)}V target)`;
          }
        }
      }
    }
  }
  return `## Three-Phase Active Front End (AFE) Parameter Optimization & Control Tuning

### 1. Operating Specifications
- **Grid Voltage ($V_{in(L-L)}$)**: $${g(vin, 4)}\\,\\text{V}_{\\text{RMS}}$ ($V_{phase,pk} = \\frac{${g(vin, 4)}}{\\sqrt{3}} \\cdot \\sqrt{2} = ${fx(vPhasePk, 2)}\\,\\text{V}$)
- **Target DC Bus ($V_{out}$)**: $${g(vout, 4)}\\,\\text{V}_{\\text{DC}}$
- **Nominal Output Power ($P_{out}$)**: $${g(power, 4)}\\,\\text{W}$
- **DC Load Resistance**:
  $$R_{DC} = \\frac{V_{out}^2}{P_{out}} = \\frac{${g(vout, 4)}^2}{${g(power, 4)}} = ${fx(rLoad, 2)}\\,\\Omega$$

### 2. AC Grid Currents & Modulation Headroom
- **Nominal Grid Current (RMS)**:
  $$I_{phase,RMS} = \\frac{P_{out}}{\\sqrt{3} \\cdot V_{in}} = \\frac{${g(power, 4)}}{\\sqrt{3} \\cdot ${g(vin, 4)}} = ${fx(iPhaseRms, 2)}\\,\\text{A}$$
- **Peak Phase Current ($I_{phase,pk}$)**:
  $$I_{phase,pk} = \\sqrt{2} \\cdot I_{phase,RMS} = ${fx(iPhasePk, 2)}\\,\\text{A}$$
- **Current Reference Clamp**: Set to $${fx(iMax, 1)}\\,\\text{A}$ ($1.4\\times$ nominal peak headroom).
- **Modulation Index**: $m = \\frac{V_{phase,pk}}{V_{DC} / 2} = \\frac{${fx(vPhasePk, 2)}}{${fx(vout / 2, 1)}} = ${fx(vPhasePk / (vout / 2.0), 3)} < 1.0$ (linear SPWM operating region).

### 3. Closed-Loop Voltage & Current Controller Tuning
- **Outer Voltage PI Loop**:
  - Proportional Gain: $K_p = 0.08$
  - Transconductance Integrator: $G_{INT} = 5\\,\\text{mA/V}$, $C_{INT} = 10\\,\\mu\\text{F}$
  - Precharged Integrator Initial Condition: $V_I(0) = ${fx(iPhasePk, 2)}\\,\\text{V}$ matching nominal steady-state current command.
- **Inner Current Loop**:
  - Proportional current error gain: $20\\,\\text{V/A}$ with $\\pm 12\\,\\text{V}$ anti-windup clamping using continuous ternary operators.
  - Low-pass PWM filtering: $R = 1\\,\\text{k}\\Omega, C = 10\\,\\text{nF}$ ($f_c \\approx 15.9\\,\\text{kHz}$).

### 4. EMI & Damping Filter Verification
- **Series RC Damping**: Damping resistors $R_{DAMP} = 2\\,\\Omega$ are wired in series with $C_{EMI} = 10\\,\\mu\\text{F}$ to damp filter resonance while completely eliminating unintended fundamental shunt grid loading.
- **DC Link Capacitor**: Sized at $${fx(cDc * 1e6, 0)}\\,\\mu\\text{F}$ to ensure DC bus ripple $< 1\\%$.
- **Semiconductor Stress**: SiC diodes and MOSFETs rated for $B_v = ${fx(bv, 0)}\\,\\text{V} \\ge 1.5 \\times V_{out}$.
`;
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

/** PWM synchronisation rules core enforces on the model's PWM settings. */
function enforcePwmRules(topologyId: unknown, updates: Updates): void {
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

const AFE = 'acdc_three_phase_active_front_end';

/**
 * Everything after the model call (core `optimize_topology_parameters`):
 * parse, normalise keys, enforce PWM rules, run the DAB / AFE adapters and
 * apply the updates. `template` is an untouched copy of the YAML.
 */
export function processReply(
  text: string,
  yaml: Dict,
  template: Dict,
  params: Dict,
): SizingOutcome {
  const afeFallback = (): SizingOutcome => {
    const fresh = structuredClone(template);
    const updates: Updates = {};
    const reasoning = adaptAfe(fresh, updates, params);
    applyUpdatesToYaml(fresh, updates, params);
    return { updates, reasoning, yaml: fresh };
  };
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
    if (yaml.id === AFE) return afeFallback();
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
    enforcePwmRules(yaml.id, updates);
    if (yaml.id === 'dcdc_dual_active_bridge') adaptDab(yaml, updates, params);
    else if (yaml.id === AFE) {
      const afe = adaptAfe(yaml, updates, params);
      if (!truthy(reasoning)) reasoning = afe;
    }
    const text2 =
      reasoning === null || reasoning === undefined ? null : pyStr(reasoning);
    if (Object.keys(updates).length === 0) {
      return { updates, reasoning: text2, yaml: structuredClone(template) };
    }
    applyUpdatesToYaml(yaml, updates, params);
    return { updates, reasoning: text2, yaml };
  } catch {
    // core: any other failure keeps the template (AFE: deterministic sizing)
    if (yaml.id === AFE) return afeFallback();
    return { updates: {}, reasoning: null, yaml: structuredClone(template) };
  }
}

/**
 * The deterministic part before any model call. Returns the outcome for the
 * DAB (core never asks the model for it), else the prompt inputs.
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
  if (lowerStr(yaml.id ?? '') === 'dcdc_dual_active_bridge') {
    const updates: Updates = {};
    const reasoning = adaptDab(yaml, updates, params);
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
    const targets = byRef.get(ref);
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
