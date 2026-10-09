import { pythonNumber } from './python-json';

/**
 * Python truthiness of a decoded JSON value: `None`, `False`, `0`, `""`,
 * `[]` and `{}` are falsy (plus `undefined`, a missing key). Unlike JS,
 * `NaN` is truthy.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b`. */
export function pyOr<A, B>(a: A, b: B): A | B {
  return pyTruthy(a) ? a : b;
}

/** Python `str(v or "").lower()`. */
export function pyLowerStr(value: unknown): string {
  if (!pyTruthy(value)) return '';
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pythonNumber(value).toLowerCase();
  return JSON.stringify(value).toLowerCase();
}

/** Python `str()` of a JSON scalar, used as a dictionary key. */
export function pyStrKey(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pythonNumber(value);
  return value;
}

/**
 * Python `round(x, digits)`: half-even on the exact decimal value of the
 * double. `toFixed(50)` is exact for 1e3 <= |x| < 1e21 (the only range the
 * callers use); other magnitudes fall back to `toFixed(digits)`.
 */
export function pythonRound(x: number, digits = 6): number {
  const magnitude = Math.abs(x);
  if (!(magnitude >= 1e3 && magnitude < 1e21)) {
    return Number(x.toFixed(digits));
  }
  const [intPart, fraction] = magnitude.toFixed(50).split('.');
  const kept = fraction.slice(0, digits);
  const rest = fraction.slice(digits);
  const restTrimmed = rest.replace(/0+$/, '');
  let roundUp: boolean;
  if (restTrimmed === '' || rest[0] < '5') roundUp = false;
  else if (rest[0] > '5' || restTrimmed.length > 1) roundUp = true;
  else {
    // Exact tie: round to the even last digit.
    const last = Number((intPart + kept).slice(-1));
    roundUp = last % 2 === 1;
  }
  let digitsText = intPart + kept;
  if (roundUp) {
    digitsText = (BigInt(digitsText) + 1n).toString();
  }
  const scaled = digitsText.padStart(digits + 1, '0');
  const text = `${scaled.slice(0, scaled.length - digits)}.${scaled.slice(scaled.length - digits)}`;
  const result = Number(text);
  return x < 0 ? -result : result;
}
