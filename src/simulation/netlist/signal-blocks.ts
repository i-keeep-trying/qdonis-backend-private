/**
 * Simulink-style control blocks (`type: gain`, `pi`, `pwm` ...): one YAML
 * component each, drawn as one schematic symbol and expanded here into plain
 * ngspice elements (B sources, a capacitor per state, PULSE sources; no
 * XSPICE). Port of qdonis-core `simulator/control_blocks.py`
 * (feature/synced-schematic); not to be confused with `control-blocks.ts`,
 * the `.control` analysis sections.
 *
 * Signals are voltages referred to ground. Inputs `in` / `in1`.. (comparator
 * `inp` / `inn`), output `out`; the gate driver has a floating `g` / `s`
 * output so it can drive a high-side switch. Steps are smoothed with `tanh`
 * because hard steps hurt ngspice convergence.
 */

import { PyError, formatG, or, pyStr, type Dict } from './py';

/** Block type -> label (also the palette label). */
export const CONTROL_BLOCK_TYPES: Readonly<Record<string, string>> = {
  gain: 'Gain',
  sum: 'Sum',
  product: 'Product',
  const: 'Constant',
  function: 'Function',
  limiter: 'Limiter',
  comparator: 'Comparator',
  integrator: 'Integrator',
  lowpass: 'Low-pass filter (first order)',
  pi: 'PI controller',
  pid: 'PID controller',
  carrier: 'Carrier (triangle / sawtooth)',
  pwm: 'PWM modulator',
  gate_driver: 'Gate driver',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  xor: 'XOR',
};

/** Parameters a new block from the palette gets. */
export const CONTROL_BLOCK_DEFAULTS: Readonly<Record<string, Dict>> = {
  // Python ints are bigint (as in design dicts), so `str()` prints "1", not "1.0".
  gain: { gain: 1n },
  sum: { signs: '+-' },
  product: { gain: 1n },
  const: { value: 1n },
  function: { expression: 'in1', inputs: 1n },
  limiter: { lower: 0n, upper: 1n },
  comparator: { high: 1n, low: 0n, threshold: 0n, width: 1e-3 },
  integrator: { ki: 1n, ic: 0n },
  lowpass: { tau: 1e-3, gain: 1n, ic: 0n },
  pi: { kp: 1n, ki: 100n, lower: -1e3, upper: 1e3, ic: 0n },
  pid: { kp: 1n, ki: 100n, kd: 0n, tf: 1e-5, lower: -1e3, upper: 1e3, ic: 0n },
  carrier: {
    frequency: 100e3,
    low: 0n,
    high: 1n,
    phase: 0n,
    shape: 'triangle',
  },
  pwm: {
    frequency: 100e3,
    low: 0n,
    high: 1n,
    phase: 0n,
    carrier: 'triangle',
    width: 1e-3,
  },
  gate_driver: { von: 15n, voff: 0n, rg: 10n, threshold: 0.5, width: 1e-3 },
  and: { high: 1n, threshold: 0.5, width: 1e-3 },
  or: { high: 1n, threshold: 0.5, width: 1e-3 },
  not: { high: 1n, threshold: 0.5, width: 1e-3 },
  xor: { high: 1n, threshold: 0.5, width: 1e-3 },
};

/** Text drawn inside the block symbol. */
export const CONTROL_BLOCK_GLYPHS: Readonly<Record<string, string>> = {
  gain: 'K',
  sum: 'Σ',
  product: '×',
  const: 'C',
  function: 'f(u)',
  limiter: '⊐⊏',
  comparator: '≥',
  integrator: '∫',
  lowpass: '1/(1+sτ)',
  pi: 'PI',
  pid: 'PID',
  carrier: '△',
  pwm: 'PWM',
  gate_driver: 'DRV',
  and: '&',
  or: '≥1',
  not: '¬',
  xor: '=1',
};

export const isControlBlock = (ctype: unknown): ctype is string =>
  typeof ctype === 'string' && Object.hasOwn(CONTROL_BLOCK_TYPES, ctype);

const IN_REF = /\bin(\d+)\b/g;
const NUMBER =
  /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(meg|MEG|Meg|[fpnuµmkKMG])?[A-Za-zΩ]*\s*$/;
// As in the core: MEG / Meg are recognised but not scaled.
const SCALE: Readonly<Record<string, number>> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  meg: 1e6,
  M: 1e6,
  G: 1e9,
};
const EXPRESSION = /^[A-Za-z0-9_+\-*/(). ]+$/;

/** Engineering text ("4.7u", "10k") -> number; null when it is not one. */
function parse(text: string): number | null {
  const match = NUMBER.exec(text);
  if (!match) return null;
  const scale = match[2] ? (SCALE[match[2]] ?? 1) : 1;
  return Number(match[1]) * scale;
}

const isNumeric = (value: unknown): value is number | bigint =>
  typeof value === 'bigint' || typeof value === 'number';

function num(params: Dict, key: string, dflt: number): number {
  const value = Object.hasOwn(params, key) ? params[key] : dflt;
  if (isNumeric(value)) return Number(value);
  return parse(pyStr(value)) ?? dflt;
}

const g = (x: number): string => formatG(x, 6);

/**
 * A parameter written into a B-source expression: a number, or a `.param`
 * name / simple expression of them (`V_TARGET`, `1/V_PEAK`), kept verbatim
 * so the design's `.param` stays the one knob.
 */
function expr(params: Dict, key: string, dflt: number): string {
  const value = Object.hasOwn(params, key) ? params[key] : dflt;
  if (isNumeric(value)) return g(Number(value));
  const text = pyStr(value).trim();
  const parsed = parse(text);
  if (parsed !== null) return g(parsed);
  if (text && EXPRESSION.test(text) && /[A-Za-z0-9_]/.test(text)) {
    return `(${text})`;
  }
  return g(dflt);
}

/** Python `str(params.get(key) or fallback)`. */
const textOr = (params: Dict, key: string, fallback: string): string =>
  pyStr(or(params[key], fallback));

const sumSigns = (params: Dict): string =>
  textOr(params, 'signs', '++').replaceAll(' ', '') || '++';

function functionInputs(params: Dict): number {
  const expression = Object.hasOwn(params, 'expression')
    ? pyStr(params.expression)
    : 'in1';
  const used = [...expression.matchAll(IN_REF)].map((m) =>
    Number.parseInt(m[1], 10),
  );
  const declared = Math.trunc(num(params, 'inputs', 1));
  return Math.max(Math.max(declared, 0), ...used);
}

/** Input and output pin names of a block, in drawing order. */
export function blockPins(
  ctype: string,
  params: Dict = {},
): { inputs: string[]; outputs: string[] } {
  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => `in${i + 1}`);
  switch (ctype) {
    case 'sum':
      return { inputs: numbered(sumSigns(params).length), outputs: ['out'] };
    case 'function':
      return { inputs: numbered(functionInputs(params)), outputs: ['out'] };
    case 'product':
    case 'and':
    case 'or':
    case 'xor':
      return { inputs: ['in1', 'in2'], outputs: ['out'] };
    case 'comparator':
      return { inputs: ['inp', 'inn'], outputs: ['out'] };
    case 'const':
    case 'carrier':
      return { inputs: [], outputs: ['out'] };
    case 'gate_driver':
      return { inputs: ['in'], outputs: ['g', 's'] };
    default:
      return { inputs: ['in'], outputs: ['out'] };
  }
}

/** Resistor of a lowpass block's RC (C = tau / R), as in the hand-made filters. */
const LAG_R = 1000;
/** State capacitor of integrator / PI / PID blocks. */
const INT_C = 1e-3;

/** Smooth unit step of `x` (0 -> 1 over about `width`). */
const step = (x: string, width: number): string =>
  `(0.5*(1+tanh((${x})/${g(Math.max(width, 1e-12))})))`;

/** Python `x % 360.0` (result has the divisor's sign). */
const mod360 = (x: number): number => ((x % 360) + 360) % 360;

/** ngspice lines for one control block; `nets` maps its pins to nodes. */
export function emitControlBlock(
  ref: string,
  ctype: string,
  params: Dict,
  nets: ReadonlyMap<string, string>,
): string[] {
  const { inputs, outputs } = blockPins(ctype, params);
  const missing = [...inputs, ...outputs].filter((pin) => !nets.get(pin));
  if (missing.length) {
    throw new PyError(
      'ValueError',
      `${ref}: control block '${ctype}' has unconnected pins: ${missing.join(', ')}`,
    );
  }
  const node = (pin: string) => nets.get(pin) as string;
  const v = (pin: string) => `V(${node(pin)})`;
  const out = outputs.length ? node(outputs[0]) : '';
  const prefix = `cb_${ref}`;
  const lines = [`* control block ${ref} (${ctype})`];
  const bout = (expression: string) =>
    lines.push(`B${ref} ${out} 0 V='${expression}'`);

  switch (ctype) {
    case 'gain':
      bout(`${expr(params, 'gain', 1)}*${v('in')}`);
      break;
    case 'sum': {
      const terms = [...sumSigns(params)].map(
        (sign, i) => (sign === '-' ? '-' : '+') + v(`in${i + 1}`),
      );
      bout(terms.join('').replace(/^\++/, '') || '0');
      break;
    }
    case 'product':
      bout(`${expr(params, 'gain', 1)}*${v('in1')}*${v('in2')}`);
      break;
    case 'const':
      bout(expr(params, 'value', 1));
      break;
    case 'function': {
      const expression = textOr(params, 'expression', 'in1');
      if (expression.includes("'")) {
        throw new PyError(
          'ValueError',
          `${ref}: the function expression may not contain quotes`,
        );
      }
      bout(expression.replace(IN_REF, (_, n: string) => v(`in${n}`)));
      break;
    }
    case 'limiter':
      bout(
        `min(max(${v('in')},${g(num(params, 'lower', 0))}),${g(num(params, 'upper', 1))})`,
      );
      break;
    case 'comparator': {
      const hi = num(params, 'high', 1);
      const lo = num(params, 'low', 0);
      const width = num(params, 'width', 1e-3);
      // Offset: high once inp - inn exceeds it (e.g. a dead-time margin).
      const threshold = num(params, 'threshold', 0);
      const diff =
        `${v('inp')}-${v('inn')}` + (threshold ? `-${g(threshold)}` : '');
      bout(`${g(lo)}+${g(hi - lo)}*${step(diff, width)}`);
      break;
    }
    case 'lowpass': {
      // tau*dout/dt = gain*in - out as an ideal source gain*in driving an RC;
      // the output node is the capacitor, so an .ic on that net applies.
      const tau = Math.max(num(params, 'tau', 1e-3), 1e-12);
      const k = num(params, 'gain', 1);
      const ic = num(params, 'ic', 0);
      lines.push(`B${ref} ${prefix}_d 0 V='${g(k)}*${v('in')}'`);
      lines.push(`R${ref}_R ${prefix}_d ${out} ${g(LAG_R)}`);
      lines.push(`C${ref}_X ${out} 0 ${g(tau / LAG_R)} IC=${g(ic)}`);
      break;
    }
    case 'integrator':
    case 'pi':
    case 'pid': {
      const pure = ctype === 'integrator';
      const ki = num(params, 'ki', pure ? 1 : 100);
      const kp = pure ? 0 : num(params, 'kp', 1);
      const kd = ctype === 'pid' ? num(params, 'kd', 0) : 0;
      const tf = Math.max(num(params, 'tf', 1e-5), 1e-12);
      const lo = num(params, 'lower', pure ? -1e9 : -1e3);
      const hi = num(params, 'upper', pure ? 1e9 : 1e3);
      const ic = num(params, 'ic', 0);
      // A pure integrator's output is its state capacitor (an .ic applies);
      // PI / PID add their terms through an output B source.
      const x = pure ? out : `${prefix}_x`;
      // Anti-windup: soft pulls the state back to the limits 100x stiffer
      // than ki; conditional stops integrating at a limit.
      const kaw = Math.max(1e4, 100 * Math.abs(ki));
      const c = INT_C;
      if (
        textOr(params, 'antiwindup', 'soft').toLowerCase() === 'conditional'
      ) {
        const kIn = `${g(ki * c)}*${v('in')}`;
        lines.push(
          `B${ref}_I 0 ${x} I='V(${x}) >= ${g(hi)} ? (${v('in')} > 0 ? 0 : ${kIn}) : ` +
            `(V(${x}) <= ${g(lo)} ? (${v('in')} < 0 ? 0 : ${kIn}) : ${kIn})'`,
        );
      } else {
        const clamp = `-${g(kaw * c)}*max(V(${x})-${g(hi)},0)+${g(kaw * c)}*max(${g(lo)}-V(${x}),0)`;
        lines.push(`B${ref}_I 0 ${x} I='${g(ki * c)}*${v('in')}${clamp}'`);
      }
      lines.push(`C${ref}_X ${x} 0 ${g(c)} IC=${g(ic)}`);
      lines.push(`R${ref}_X ${x} 0 1e12`);
      const terms = [`V(${x})`];
      if (kp) terms.unshift(`${g(kp)}*${v('in')}`);
      if (kd) {
        // Filtered derivative: y = in lagged by tf, D = kd*(in - y)/tf.
        const y = `${prefix}_y`;
        lines.push(`B${ref}_D ${prefix}_yd 0 V='${v('in')}'`);
        lines.push(`R${ref}_Y ${prefix}_yd ${y} ${g(LAG_R)}`);
        lines.push(`C${ref}_Y ${y} 0 ${g(tf / LAG_R)} IC=0`);
        terms.push(`${g(kd / tf)}*(${v('in')}-V(${y}))`);
      }
      if (!pure) bout(`min(max(${terms.join('+')},${g(lo)}),${g(hi)})`);
      break;
    }
    case 'carrier':
    case 'pwm': {
      const f = num(params, 'frequency', 100e3);
      if (f <= 0) {
        throw new PyError('ValueError', `${ref}: frequency must be positive`);
      }
      const period = 1 / f;
      const shape = textOr(
        params,
        ctype === 'carrier' ? 'shape' : 'carrier',
        'triangle',
      ).toLowerCase();
      const [cLo, cHi] =
        ctype === 'carrier'
          ? [num(params, 'low', 0), num(params, 'high', 1)]
          : [0, 1];
      const td = (mod360(num(params, 'phase', 0)) / 360) * period;
      // No flat top: a plateau at every peak forces tiny steps there. The
      // sawtooth keeps a short fall (1e-4 of the period).
      const eps = period * 1e-4;
      const [tr, fall] = shape.startsWith('saw')
        ? [period - eps, eps]
        : [period / 2, period / 2];
      const car = ctype === 'carrier' ? out : `${prefix}_car`;
      lines.push(
        `V${ref}_CAR ${car} 0 PULSE(${g(cLo)} ${g(cHi)} ${g(td)} ${g(tr)} ${g(fall)} ${g(0)} ${g(period)})`,
      );
      if (ctype === 'pwm') {
        const hi = num(params, 'high', 1);
        const lo = num(params, 'low', 0);
        const width = num(params, 'width', 1e-3);
        bout(`${g(lo)}+${g(hi - lo)}*${step(`${v('in')}-V(${car})`, width)}`);
      }
      break;
    }
    case 'gate_driver': {
      const von = num(params, 'von', 15);
      const voff = num(params, 'voff', 0);
      const threshold = num(params, 'threshold', 0.5);
      const width = num(params, 'width', 1e-3);
      const rg = Math.max(num(params, 'rg', 10), 1e-3);
      const internal = `${prefix}_drv`;
      const diff = `${v('in')}-${g(threshold)}`;
      lines.push(
        `B${ref} ${internal} ${node('s')} V='${g(voff)}+${g(von - voff)}*${step(diff, width)}'`,
      );
      lines.push(`R${ref}_G ${internal} ${node('g')} ${g(rg)}`);
      break;
    }
    case 'and':
    case 'or':
    case 'not':
    case 'xor': {
      const hi = num(params, 'high', 1);
      const threshold = num(params, 'threshold', 0.5);
      const width = num(params, 'width', 1e-3);
      if (ctype === 'not') {
        bout(`${g(hi)}*(1-${step(`${v('in')}-${g(threshold)}`, width)})`);
        break;
      }
      const a = step(`${v('in1')}-${g(threshold)}`, width);
      const b = step(`${v('in2')}-${g(threshold)}`, width);
      const logic =
        ctype === 'and'
          ? `${a}*${b}`
          : ctype === 'or'
            ? `(${a}+${b}-${a}*${b})`
            : `(${a}+${b}-2*${a}*${b})`;
      bout(`${g(hi)}*${logic}`);
      break;
    }
    default:
      throw new PyError(
        'ValueError',
        `${ref}: unknown control block type ${ctype}`,
      );
  }
  return lines;
}

/** Short value text shown next to the block symbol. */
export function describeControlBlock(ctype: string, params: Dict = {}): string {
  const n = (key: string, dflt: number) => g(num(params, key, dflt));
  switch (ctype) {
    case 'gain':
      return `k=${trimParens(expr(params, 'gain', 1))}`;
    case 'sum':
      return textOr(params, 'signs', '++');
    case 'const':
      return trimParens(expr(params, 'value', 1));
    case 'function':
      return [...textOr(params, 'expression', '')].slice(0, 30).join('');
    case 'limiter':
      return `[${n('lower', 0)}, ${n('upper', 1)}]`;
    case 'integrator':
      return `ki=${n('ki', 1)}`;
    case 'lowpass':
      return `τ=${n('tau', 1e-3)} s`;
    case 'pi':
      return `kp=${n('kp', 1)} ki=${n('ki', 100)}`;
    case 'pid':
      return `kp=${n('kp', 1)} ki=${n('ki', 100)} kd=${n('kd', 0)}`;
    case 'carrier':
    case 'pwm': {
      const f = num(params, 'frequency', 100e3);
      return f >= 1e3 ? `${g(f / 1e3)} kHz` : `${g(f)} Hz`;
    }
    case 'gate_driver':
      return `${n('voff', 0)}/${n('von', 15)} V`;
    default:
      return '';
  }
}

/** Python `text.strip('()')`. */
const trimParens = (text: string): string => text.replace(/^[()]+|[()]+$/g, '');

export interface PinGeometry {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Pin geometry of the block symbol: inputs left, outputs right, 20 px grid. */
export function controlBlockSymbolPins(
  ctype: string,
  params: Dict = {},
): Record<string, PinGeometry> {
  const { inputs, outputs } = blockPins(ctype, params);
  const table: Record<string, PinGeometry> = {};
  for (const [names, x, dx] of [
    [inputs, -40, -1],
    [outputs, 40, 1],
  ] as const) {
    names.forEach((name, k) => {
      // Python round(): half to even.
      const y = roundHalfEven(((k - (names.length - 1) / 2) * 40) / 20) * 20;
      table[name] = { x, y: y === 0 ? 0 : y, dx, dy: 0 };
    });
  }
  return table;
}

function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
