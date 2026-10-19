/**
 * Simulation timing read from the design, ported from qdonis-core
 * `simulator/netlist_generator.py` (`parse_value`, `_line_period`,
 * `_detect_pwm_period`, `_align_window_to_line_cycles`).
 */

import {
  PyError,
  fmt,
  get,
  has,
  isDict,
  iter,
  or,
  pyStr,
  splitWs,
  toFloat,
  type Dict,
} from './py';

const SPICE_SCALE: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

const SPICE_NUMBER = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(meg|[tgkmunpf])?/i;

/** Number with an optional SPICE scale suffix ('50', '0.0625m', '10k') -> float. */
export function parseValue(value: unknown): number | null {
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return toFloat(value);
  }
  const m = SPICE_NUMBER.exec(pyStr(value));
  if (!m) return null;
  return Number(m[1]) * (SPICE_SCALE[(m[2] ?? '').toLowerCase()] ?? 1);
}

/** Every component, internal parts included, in the core's stack (LIFO) order. */
function* stackOrder(design: Dict): Generator<Dict> {
  const stack = [...iter(or(get(design, 'components', []), []))];
  while (stack.length) {
    const comp = stack.pop();
    if (!isDict(comp)) continue;
    stack.push(...iter(or(get(comp, 'internal', []), [])));
    yield comp;
  }
}

const RAW_SINE = /\bSINE?\s*\(\s*\S+\s+\S+\s+([^\s)]+)/i;

/** Period of the slowest line-frequency (< 1 kHz) sine source, or null. */
export function linePeriod(design: Dict): number | null {
  const freqs: number[] = [];
  for (const comp of stackOrder(design)) {
    const params = or(get(comp, 'params'), {});
    let f: number | null = null;
    if (pyStr(get(params, 'source', '')).toLowerCase() === 'sine') {
      f = parseValue(get(params, 'frequency', 60n));
    } else {
      // Raw sources such as "V2 ControlA 0 SINE(0 8 50)" (modulation references)
      const m = RAW_SINE.exec(pyStr(get(params, 'spice_line', '')));
      if (m) f = parseValue(m[1]);
    }
    if (f !== null && f > 0 && f < 1000) freqs.push(f);
  }
  return freqs.length ? 1 / Math.min(...freqs) : null;
}

const PULSE = /PULSE\s*\(\s*([^)]+)\)/i;

/** Period (7th field) of a `PULSE(...)` in a raw SPICE line. */
function pulsePeriod(spiceLine: string): number | null {
  const m = PULSE.exec(spiceLine);
  if (!m) return null;
  const parts = splitWs(m[1]);
  return parts.length >= 7 ? parseValue(parts[6]) : null;
}

/** Switching / PWM carrier period (s) from the design's components, or null. */
export function detectPwmPeriod(design: Dict): number | null {
  for (const comp of stackOrder(design)) {
    const params = or(get(comp, 'params'), {});
    const role = pyStr(get(comp, 'role', '')).toLowerCase();

    // Explicit pwm_control node
    if (
      get(comp, 'type') === 'node' &&
      get(params, 'node_type') === 'pwm_control' &&
      has(params, 'frequency')
    ) {
      const f = parseValue(get(params, 'frequency'));
      if (f && f > 0) return 1 / f;
    }

    const spiceLine = pyStr(get(params, 'spice_line', ''));
    // Carrier source (custom_spice or node)
    if (role.includes('carrier') || role.includes('pwm')) {
      if (has(params, 'frequency')) {
        const f = parseValue(get(params, 'frequency'));
        if (f && f > 0) return 1 / f;
      }
      if (has(params, 'period')) {
        const p = parseValue(get(params, 'period'));
        if (p && p > 0) return p;
      }
      const p = pulsePeriod(spiceLine);
      if (p && p > 0) return p;
    }

    // Any other PULSE source with a switching-like period (< 100 ms)
    if (spiceLine.toUpperCase().includes('PULSE')) {
      const p = pulsePeriod(spiceLine);
      if (p && p > 0 && p < 0.1) return p;
    }
  }
  return null;
}

const LINE_CYCLE_COMMANDS = new Set(['AVG', 'RMS', 'PP']);

/**
 * AVG/RMS/PP of line-frequency waveforms (rectified outputs, AC currents,
 * inverter outputs) are only meaningful over whole line cycles; the default
 * "last 20% of t_stop" window is a fraction of a 50/60 Hz cycle. Stretches
 * the window back to the largest whole number of line periods (at least one
 * half period) that fits in the second half of the simulation.
 */
export function alignWindowToLineCycles(
  spiceCommand: string,
  winFrom: string | null,
  winTo: string | null,
  period: number | null,
): [string | null, string | null] {
  if (!period || !winFrom || !winTo) return [winFrom, winTo];
  const head = splitWs(spiceCommand)[0];
  if (head === undefined) {
    throw new PyError('IndexError', 'list index out of range');
  }
  if (!LINE_CYCLE_COMMANDS.has(head.toUpperCase())) return [winFrom, winTo];
  let tFrom: number;
  let tTo: number;
  try {
    tFrom = toFloat(winFrom);
    tTo = toFloat(winTo);
  } catch {
    return [winFrom, winTo];
  }
  const width = tTo - tFrom;
  if (width <= 0) return [winFrom, winTo];
  const span = 0.5 * tTo;
  let unit: number;
  if (span >= period) unit = period;
  else if (span >= 0.5 * period) unit = 0.5 * period;
  else return [winFrom, winTo];
  let cycles = Math.max(1, Math.trunc(Math.max(width, unit) / unit + 1e-9));
  cycles = Math.min(cycles, Math.trunc(span / unit + 1e-9));
  return [fmt(tTo - cycles * unit), winTo];
}
