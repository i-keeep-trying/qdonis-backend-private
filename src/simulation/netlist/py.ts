/**
 * Python value semantics the netlist generator depends on. Design dicts keep
 * Python's int / float distinction: YAML integers are `bigint`, floats are
 * `number`, so `str()` and f-strings print exactly what qdonis-core printed
 * (`12` vs `12.0`).
 */

import { pythonFloatRepr } from '../../common/python/python-json';

export type Dict = Record<string, unknown>;

/** A Python exception, carrying its class name (`ValueError`, ...). */
export class PyError extends Error {
  constructor(
    readonly pyType: string,
    message: string,
  ) {
    super(message);
    this.name = pyType;
  }
}

export const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Map);

export const isNumberLike = (value: unknown): value is number | bigint =>
  typeof value === 'number' || typeof value === 'bigint';

const typeName = (value: unknown): string => {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return 'float';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
};

/** `obj.get(key, default)`; AttributeError when `obj` is not a dict. */
export function get(obj: unknown, key: string, dflt?: unknown): unknown {
  if (!isDict(obj)) {
    throw new PyError(
      'AttributeError',
      `'${typeName(obj)}' object has no attribute 'get'`,
    );
  }
  return Object.hasOwn(obj, key) ? obj[key] : dflt;
}

/** `obj[key]`; KeyError when missing. */
export function item(obj: unknown, key: string): unknown {
  if (!isDict(obj)) {
    throw new PyError(
      'TypeError',
      `'${typeName(obj)}' object is not subscriptable`,
    );
  }
  if (!Object.hasOwn(obj, key)) throw new PyError('KeyError', `'${key}'`);
  return obj[key];
}

/** `key in obj` for a dict (TypeError for non-containers). */
export function has(obj: unknown, key: string): boolean {
  if (isDict(obj)) return Object.hasOwn(obj, key);
  if (Array.isArray(obj)) return obj.some((value) => pyEquals(value, key));
  if (typeof obj === 'string') return obj.includes(key);
  throw new PyError(
    'TypeError',
    `argument of type '${typeName(obj)}' is not iterable`,
  );
}

/** Python truthiness. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b` (returns the operand, not a boolean). */
export const or = <A, B>(a: A, b: B): A | B => (truthy(a) ? a : b);

/** Python `==` for decoded YAML / JSON values. */
export function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const num = (v: unknown): number | null =>
    typeof v === 'boolean'
      ? Number(v)
      : typeof v === 'bigint'
        ? Number(v)
        : typeof v === 'number'
          ? v
          : null;
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na === nb;
  if ((a ?? null) === null || (b ?? null) === null) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => pyEquals(v, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && pyEquals(a[k], b[k]))
    );
  }
  return false;
}

const FLOAT_TEXT =
  /^[-+]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][-+]?\d(?:_?\d)*)?|\d(?:_?\d)*\.?(?:[eE][-+]?\d(?:_?\d)*)?)$/;

/** Python `float(value)`. */
export function toFloat(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    const lower = text.toLowerCase();
    const bare = lower.replace(/^[-+]/, '');
    if (bare === 'inf' || bare === 'infinity' || bare === 'nan') {
      if (bare === 'nan') return Number.NaN;
      return lower.startsWith('-') ? -Infinity : Infinity;
    }
    if (FLOAT_TEXT.test(text)) return Number(text.replace(/_/g, ''));
    throw new PyError(
      'ValueError',
      `could not convert string to float: ${pyRepr(value)}`,
    );
  }
  throw new PyError(
    'TypeError',
    `float() argument must be a string or a real number, not '${typeName(value)}'`,
  );
}

/** `repr(float)`. */
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return pythonFloatRepr(value);
}

/** `repr(str)`. */
function strRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) {
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    } else out += ch;
  }
  return out + quote;
}

export function pyRepr(value: unknown): string {
  return typeof value === 'string' ? strRepr(value) : pyStr(value);
}

/** Python `str(value)` / f-string `{value}`. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return floatRepr(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (value instanceof Set) return `{${[...value].map(pyRepr).join(', ')}}`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${strRepr(k)}: ${pyRepr(v)}`)
      .join(', ')}}`;
  }
  return typeof value === 'symbol' || typeof value === 'function'
    ? value.toString()
    : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Exact decimal rounding (Python formats from the exact binary value with
// round-half-even; JS toFixed / toExponential round ties away from zero).
// ---------------------------------------------------------------------------

interface Exact {
  negative: boolean;
  /** Decimal digits of |value| * 10^scale (no leading zeros, "0" for zero). */
  digits: string;
  scale: number;
}

function exactDecimal(value: number): Exact {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let e: number;
  if (exponent === 0) e = -1074;
  else {
    mantissa |= 1n << 52n;
    e = exponent - 1075;
  }
  if (mantissa === 0n) return { negative, digits: '0', scale: 0 };
  if (e >= 0)
    return { negative, digits: (mantissa << BigInt(e)).toString(), scale: 0 };
  return {
    negative,
    digits: (mantissa * 5n ** BigInt(-e)).toString(),
    scale: -e,
  };
}

/**
 * Rounds a digit string to its first `keep` digits, half-even. Returns the
 * rounded leading digits (one longer than `keep` when rounding carried out,
 * e.g. "99" -> "100") and whether that happened.
 */
function roundDigits(digits: string, keep: number): [string, boolean] {
  if (digits.length <= keep) return [digits.padEnd(keep, '0'), false];
  const head = digits.slice(0, keep);
  const rest = digits.slice(keep);
  let up: boolean;
  if (rest[0] > '5') up = true;
  else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = keep > 0 && Number(head[head.length - 1]) % 2 === 1;
  if (!up) return [head, false];
  const bumped = (BigInt(head || '0') + 1n).toString();
  if (bumped.length > keep) return [bumped, true];
  return [bumped.padStart(keep, '0'), false];
}

const stripZeros = (text: string): string =>
  text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;

/** `format(value, '.{p}g')` for a float. */
export function formatG(value: number, precision = 6): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const p = Math.max(precision, 1);
  const { negative, digits, scale } = exactDecimal(value);
  const sign = negative ? '-' : '';
  if (digits === '0') return `${sign}0`;
  let exp = digits.length - 1 - scale;
  const [roundedRaw, carried] = roundDigits(digits, p);
  if (carried) exp += 1;
  const rounded = roundedRaw.slice(0, p);
  let body: string;
  if (exp < -4 || exp >= p) {
    const mantissa = stripZeros(`${rounded[0]}.${rounded.slice(1)}`);
    body = `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  } else if (exp < 0) {
    body = stripZeros(`0.${'0'.repeat(-exp - 1)}${rounded}`);
  } else {
    body = stripZeros(`${rounded.slice(0, exp + 1)}.${rounded.slice(exp + 1)}`);
  }
  return sign + body;
}

/** Digits of round(|value| * 10^decimals) half-even, as a decimal string. */
function scaledInteger(value: number, decimals: number): [boolean, string] {
  const { negative, digits, scale } = exactDecimal(value);
  if (digits === '0') return [negative, '0'];
  if (scale <= decimals) {
    return [negative, digits + '0'.repeat(decimals - scale)];
  }
  const cut = digits.length - (scale - decimals);
  if (cut < 0) return [negative, '0']; // below half a unit of the last place
  const [r] = roundDigits(digits, cut);
  return [negative, r || '0'];
}

/** `format(value, '.{d}f')`. */
export function formatFixed(value: number, decimals: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const [negative, text] = scaledInteger(value, decimals);
  const padded = text.replace(/^0+(?=\d)/, '').padStart(decimals + 1, '0');
  const body =
    decimals > 0
      ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`
      : padded;
  return (negative ? '-' : '') + body;
}

/** Python `round(value)` for a float: half-even integer. */
export function roundInt(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new PyError(
      Number.isNaN(value) ? 'ValueError' : 'OverflowError',
      'cannot convert float to integer',
    );
  }
  const [negative, text] = scaledInteger(value, 0);
  const result = BigInt(text);
  return negative ? -result : result;
}

/** Python `int(value)` for a float (truncation). */
export function truncInt(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new PyError('ValueError', 'cannot convert float to integer');
  }
  return BigInt(Math.trunc(value));
}

/** `fmt()` of the netlist generator: `f"{float(x):.6g}"`, else `str(x)`. */
export function fmt(value: unknown): string {
  try {
    return formatG(toFloat(value), 6);
  } catch {
    return pyStr(value);
  }
}

/** Python `str.split()` with no separator. */
const PY_SPLIT = new RegExp(
  `[\\s${String.fromCharCode(0x1c)}-${String.fromCharCode(0x1f)}\\u0085]+`,
  'u',
);
export const splitWs = (text: string): string[] =>
  text.split(PY_SPLIT).filter((part) => part.length > 0);

/** Python `str.replace(old, new)` (all occurrences, no `$` patterns). */
export const replaceAll = (text: string, from: string, to: string): string =>
  from === '' ? text : text.split(from).join(to);

/** Python `str.replace(old, new, 1)`. */
export function replaceFirst(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
}

/** Python `str.lower()` of a value that must be a string. */
export function lower(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PyError(
      'AttributeError',
      `'${typeName(value)}' object has no attribute 'lower'`,
    );
  }
  return value.toLowerCase();
}

/** Python `len()` for lists / strings / dicts. */
export function len(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (isDict(value)) return Object.keys(value).length;
  throw new PyError(
    'TypeError',
    `object of type '${typeName(value)}' has no len()`,
  );
}

/** Python iteration over a list / tuple (TypeError otherwise, empty for dict keys). */
export function iter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${typeName(value)}' object is not iterable`);
}

/** Python `x[i]` for a list / string. */
export function at(value: unknown, index: number): unknown {
  if (typeof value === 'string' || Array.isArray(value)) {
    const i = index < 0 ? value.length + index : index;
    if (i < 0 || i >= value.length) {
      throw new PyError('IndexError', 'list index out of range');
    }
    return value[i];
  }
  if (isDict(value)) return item(value, String(index));
  throw new PyError(
    'TypeError',
    `'${typeName(value)}' object is not subscriptable`,
  );
}

/** Python `a > b` / numeric comparison for values `float()` accepts. */
export const num = (value: unknown): number => toFloat(value);
