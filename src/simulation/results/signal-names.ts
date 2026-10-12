/**
 * Waveform naming shared by the plot builder and the loss engine. Port of
 * qdonis-core `simulator/signal_names.py`.
 */

import { get, isDict, iter, pyStr, truthy, type Dict } from '../netlist/py';

export const PHYSICAL_TYPES = new Set([
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'transistor',
  'mosfet',
  'igbt',
  'switch',
  'transformer',
  'ct_transformer',
  'dual_ct_transformer',
]);

const AUTO_RE = /^(V|I|Gate)_(.+)$/s;
const LEGACY_V_RE =
  /^(\s*wrdata\s+time_series\/)(\S+)_V\.csv(\s+v_(\S+?)_auto\s*)$/;
const LEGACY_GATE_RE = /^(\s*wrdata\s+time_series\/)tr_gate_(\S+)\.csv(\s+.*)$/;
const LEGACY_I_RE =
  /^(\s*wrdata\s+time_series\/)(\S+?)(_pri|_sec)?_I\.csv(\s+.*)$/;

/** Python `str.splitlines()` line boundaries (includes \x1c-\x1e separators). */
const LINE_BREAK = new RegExp(
  String.raw`\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]`,
);
const TRAILING_BREAK = new RegExp(`(?:${LINE_BREAK.source})$`);

/** Python `str.splitlines()` (no keepends). */
export function splitLines(text: string): string[] {
  const parts = text.split(LINE_BREAK);
  if (
    parts.length > 0 &&
    parts[parts.length - 1] === '' &&
    TRAILING_BREAK.test(text)
  ) {
    parts.pop();
  }
  return text === '' ? [] : parts;
}

/** Rewrites legacy telemetry CSV names to the V_/I_/Gate_ convention. */
export function upgradeLegacyTelemetry(deck: string): [string, boolean] {
  const lines = splitLines(deck);
  const refs = new Set<string>();
  for (const line of lines) {
    const m = LEGACY_V_RE.exec(line);
    if (m && m[2].endsWith(`_${m[4]}`)) refs.add(m[4]);
  }
  if (refs.size === 0 && !deck.includes('time_series/tr_gate_'))
    return [deck, false];
  const byLength = [...refs].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  let changed = false;
  const out: string[] = [];
  for (const line of lines) {
    let next = line;
    const v = LEGACY_V_RE.exec(line);
    if (v && refs.has(v[4]) && v[2].endsWith(`_${v[4]}`)) {
      next = `${v[1]}V_${v[4]}.csv${v[3]}`;
    } else {
      const g = LEGACY_GATE_RE.exec(line);
      if (g) next = `${g[1]}Gate_${g[2]}.csv${g[3]}`;
      else {
        const i = LEGACY_I_RE.exec(line);
        const stemTail = i ? (i[2].split('/').pop() ?? '') : '';
        if (i && !['I_', 'V_', 'Gate_'].some((p) => stemTail.startsWith(p))) {
          const ref = byLength.find((r) => i[2].endsWith(`_${r}`));
          if (ref) next = `${i[1]}I_${ref}${i[3] ?? ''}.csv${i[4]}`;
        }
      }
    }
    if (next !== line) changed = true;
    out.push(next);
  }
  return [out.join('\n'), changed];
}

function componentsByRef(yamlData: unknown): Map<string, Dict> {
  const comps = new Map<string, Dict>();
  const list = isDict(yamlData) ? get(yamlData, 'components', []) : [];
  for (const c of truthy(list) ? iter(list) : []) {
    if (isDict(c) && truthy(get(c, 'ref'))) comps.set(pyStr(c.ref), c);
  }
  return comps;
}

function isPwmSource(ref: string, comps: Map<string, Dict>): boolean {
  const comp = comps.get(ref);
  if (comp !== undefined) {
    if (PHYSICAL_TYPES.has(get(comp, 'type') as string)) return false;
    const nodeType = get(get(comp, 'params') ?? {}, 'node_type', '');
    return (
      nodeType === 'pwm_control' ||
      get(comp, 'type') === 'pwm_control' ||
      ref.toUpperCase().startsWith('PWM')
    );
  }
  return ref.toUpperCase().startsWith('PWM');
}

/** Label and gate flag for an auto-telemetry CSV stem (V_SW1, I_T1_pri, Gate_SW1). */
export function autoTraceLabel(
  stem: string,
  yamlData: unknown,
): [string, boolean] | null {
  const m = AUTO_RE.exec(stem);
  if (!m) return null;
  const [, kind, ref] = m;
  if (kind === 'V') return [`${ref}_V`, false];
  if (kind === 'I') {
    const w = /^(.+)_(pri|sec)$/s.exec(ref);
    return w ? [`${w[1]}_${w[2].toUpperCase()}_I`, false] : [`${ref}_I`, false];
  }
  return [
    isPwmSource(ref, componentsByRef(yamlData)) ? ref : `${ref}_Gate`,
    true,
  ];
}

const SYSTEM_SIGNAL_RE = /^(V|I)_?(OUT|IN|LOAD|DC_OUT|LINE|BUS)/i;
const CONTROL_PINS = new Set(['gate', 'base', 'ctrl+', 'ctrl-']);

/** Standard label of a YAML measurement (<REF>_V / <REF>_I / <REF>_Gate, else its ref). */
export function measurementLabel(
  measurement: unknown,
  yamlData: unknown,
): unknown {
  if (!isDict(measurement)) return null;
  const ref = get(measurement, 'ref');
  if (truthy(ref) && SYSTEM_SIGNAL_RE.test(pyStr(ref))) return ref;
  const comps = componentsByRef(yamlData);
  const quantity = pyStr(get(measurement, 'quantity', '')).toLowerCase();
  const physical = (r: unknown) => {
    const c = typeof r === 'string' ? comps.get(r) : undefined;
    return c !== undefined && PHYSICAL_TYPES.has(get(c, 'type') as string);
  };
  if (quantity === 'current') {
    const comp = get(measurement, 'component');
    if (truthy(comp) && physical(comp)) return `${pyStr(comp)}_I`;
  } else if (quantity === 'voltage') {
    const nets = get(measurement, 'nets');
    if (Array.isArray(nets) && nets.length === 2) {
      let a: unknown = null;
      let pa: unknown = null;
      let b: unknown = null;
      let pb: unknown = null;
      const first = nets[0] as unknown;
      const second = nets[1] as unknown;
      if (
        Array.isArray(first) &&
        Array.isArray(second) &&
        first.length >= 2 &&
        second.length >= 2
      ) {
        [a, pa] = first as unknown[];
        [b, pb] = second as unknown[];
      }
      if (truthy(a) && a === b && physical(a)) {
        if (
          CONTROL_PINS.has(pyStr(pa).toLowerCase()) ||
          CONTROL_PINS.has(pyStr(pb).toLowerCase())
        ) {
          return `${pyStr(a)}_Gate`;
        }
        return `${pyStr(a)}_V`;
      }
    } else if (!truthy(nets)) {
      const comp = get(measurement, 'component');
      if (truthy(comp) && physical(comp)) return `${pyStr(comp)}_V`;
    }
  }
  return ref;
}
