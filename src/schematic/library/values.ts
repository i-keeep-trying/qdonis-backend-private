/**
 * Parameter values as the drawing shows (and edits) them, and the value text
 * beside each symbol. Port of the "Values" part of qdonis-core
 * `schematic_sync.py`.
 */

import { describeControlBlock } from '../../simulation/netlist/signal-blocks';
import {
  formatG,
  isDict,
  or,
  pyStr,
  truthy,
  type Dict,
} from '../../simulation/netlist/py';
import { isAcSource, paramsOf } from './symbols';
import { isControlBlock } from '../../simulation/netlist/signal-blocks';

const PREFIXES: ReadonlyArray<readonly [number, string]> = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];
const SCALE: Readonly<Record<string, number>> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  meg: 1e6,
  G: 1e9,
};
const NUMBER =
  /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(meg|MEG|Meg|[fpnuµmkKMG])?\s*([A-Za-zΩ°%]{0,3})\s*$/;
const PLAIN_NUMBER = /^\s*[-+]?[\d.]+(?:[eE][-+]?\d+)?\s*$/;

const scaleOf = (prefix: string): number | undefined =>
  Object.hasOwn(SCALE, prefix) ? SCALE[prefix] : undefined;

/** Whole-string engineering number: 47u, 4.7e-5, 100 kHz, 1 MΩ (M = mega); null if not one. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const match = NUMBER.exec(pyStr(value));
  if (!match) return null;
  let prefix = match[2] ?? '';
  const unit = match[3] ?? '';
  // "5ms", "100kHz" written without a space
  if (!prefix && scaleOf(unit.slice(0, 1)) !== undefined && unit.length > 1) {
    prefix = unit.slice(0, 1);
  }
  const number = Number(match[1]);
  if (!prefix) return number;
  return number * (scaleOf(prefix) ?? scaleOf(prefix.toLowerCase()) ?? 1);
}

/** 2.2e-5 -> "22u" (six significant digits). */
export function fmtEng(value: number, micro = 'u'): string {
  if (value === 0) return '0';
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
  }
  const magnitude = Math.abs(value);
  for (const [scale, prefix] of PREFIXES) {
    if (magnitude >= scale * (1 - 1e-9)) {
      return formatG(value / scale, 6) + (prefix === 'u' ? micro : prefix);
    }
  }
  return formatG(value, 6);
}

/** How a parameter is shown (and edited) in the drawing. */
export function fmtParam(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') {
    return fmtEng(Number(value));
  }
  if (typeof value === 'string') {
    const number = parseNumber(value);
    if (number !== null && PLAIN_NUMBER.test(value)) return fmtEng(number);
    return value;
  }
  return pyStr(value);
}

/** Scalar parameters as display text (nested values and nulls left out). */
export function scalarParams(params: Dict): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) || isDict(value)) continue;
    out[key] = fmtParam(value);
  }
  return out;
}

/** Python `str(value)[:n]`, counted in code points. */
const head = (value: unknown, n: number): string =>
  Array.from(pyStr(value)).slice(0, n).join('');

/** The value text drawn beside a part ("22µH", "n=0.5 · Lm 1mH"). */
export function displayText(comp: Dict): string {
  const params = paramsOf(comp);
  const ctype = comp.type;
  if (isControlBlock(ctype)) return describeControlBlock(ctype, params);

  const si = (key: string, unit: string): string => {
    const number = parseNumber(params[key]);
    return number !== null ? `${fmtEng(number, 'µ')}${unit}` : '';
  };

  switch (ctype) {
    case 'resistor':
      return si('resistance', 'Ω');
    case 'capacitor':
      return si('capacitance', 'F');
    case 'inductor':
      return si('inductance', 'H');
    case 'transformer':
    case 'ct_transformer':
    case 'dual_ct_transformer': {
      const n = parseNumber(params.turns_ratio);
      const lm = si('Lm_primary', 'H');
      return [n !== null ? `n=${fmtEng(n)}` : '', lm ? `Lm ${lm}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    case 'e_source':
    case 'g_source': {
      if (truthy(params.expression) || truthy(params.value)) {
        return head(or(params.expression, params.value), 30);
      }
      const gain = Object.hasOwn(params, 'gain')
        ? params.gain
        : params.transconductance;
      return gain !== null && gain !== undefined
        ? `gain ${fmtParam(gain)}`
        : '';
    }
    case 'b_source':
      return head(or(or(params.expression, params.i_expression), ''), 30);
    case 'custom_spice':
      return head(or(params.spice_line, ''), 48);
    case 'switch':
      return pyStr(or(params.model, ''));
    case 'transistor':
    case 'mosfet':
    case 'igbt':
      return pyStr(or(or(params.part_number, params.model), ''));
    case 'node': {
      if (params.node_type === 'voltage_source') {
        if (isAcSource(params)) {
          const amp = si('amplitude', 'V') || si('voltage', 'V');
          const freq = si('frequency', 'Hz');
          return freq ? `${amp} pk · ${freq}` : amp;
        }
        return si('voltage', 'V');
      }
      if (params.node_type === 'pwm_control') {
        const freq = si('frequency', 'Hz');
        const duty = parseNumber(params.duty_cycle);
        return duty !== null ? `${freq} · D=${formatG(duty, 3)}` : freq;
      }
      return '';
    }
    default:
      return '';
  }
}
