/**
 * The numpy operations the loss engine relies on, with numpy's exact
 * floating-point order (pairwise summation for `sum` / `mean`).
 */

/** `np.add.reduce` on a contiguous float64 array (pairwise, block 128, unroll 8). */
export function pairwiseSum(
  values: ArrayLike<number>,
  lo = 0,
  n = values.length - lo,
): number {
  if (n < 8) {
    let r = -0.0;
    for (let i = 0; i < n; i += 1) r += values[lo + i];
    return r;
  }
  if (n <= 128) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => values[lo + j]);
    let i = 8;
    const end = n - (n % 8);
    for (; i < end; i += 8) {
      for (let j = 0; j < 8; j += 1) r[j] += values[lo + i + j];
    }
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i += 1) res += values[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(values, lo, n2) + pairwiseSum(values, lo + n2, n - n2);
}

/** `np.mean` (NaN for an empty array, like numpy's warning path). */
export function mean(values: ArrayLike<number>): number {
  return values.length === 0 ? Number.NaN : pairwiseSum(values) / values.length;
}

/** `np.max` (NaN propagates; throws on empty like numpy). */
export function max(
  values: ArrayLike<number>,
  lo = 0,
  hi = values.length,
): number {
  if (hi <= lo)
    throw new Error(
      'zero-size array to reduction operation maximum which has no identity',
    );
  let m = values[lo];
  for (let i = lo + 1; i < hi; i += 1) {
    const v = values[i];
    if (Number.isNaN(m)) return m;
    if (Number.isNaN(v) || v > m) m = v;
  }
  return m;
}

/** `np.min`. */
export function min(
  values: ArrayLike<number>,
  lo = 0,
  hi = values.length,
): number {
  if (hi <= lo)
    throw new Error(
      'zero-size array to reduction operation minimum which has no identity',
    );
  let m = values[lo];
  for (let i = lo + 1; i < hi; i += 1) {
    const v = values[i];
    if (Number.isNaN(m)) return m;
    if (Number.isNaN(v) || v < m) m = v;
  }
  return m;
}

/** `np.argmin` / `np.argmax` over a slice (first occurrence, NaN wins). */
export function argExtreme(
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  wantMax: boolean,
): number {
  let best = lo;
  for (let i = lo; i < hi; i += 1) {
    const v = values[i];
    if (Number.isNaN(v)) return i - lo;
    if (wantMax ? v > values[best] : v < values[best]) best = i;
  }
  return best - lo;
}

/** `np.searchsorted(grid, x)` with side='left'. */
export function searchSorted(grid: readonly number[], x: number): number {
  let lo = 0;
  let hi = grid.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (grid[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `np.maximum(0.0, x)` (NaN propagates). */
export const maximum0 = (x: number): number =>
  Number.isNaN(x) ? x : x > 0 ? x : 0 < x ? x : 0;

/** Python 3.12+ `sum()` of floats: Neumaier compensated summation from 0. */
export function pySum(values: Iterable<number>): number {
  let result = 0.0;
  let c = 0.0;
  for (const x of values) {
    const t = result + x;
    if (Math.abs(result) >= Math.abs(x)) c += result - t + x;
    else c += x - t + result;
    result = t;
  }
  return c !== 0 && Number.isFinite(c) ? result + c : result;
}

/** Python `max(0.0, x)` for floats (NaN -> 0.0). */
export const pyMax0 = (x: number): number => (x > 0 ? x : 0);

/** Python `round(x, digits)` for a float (correctly rounded, half-even). */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  return Number(roundText(x, digits));
}

function roundText(x: number, digits: number): string {
  // Exact decimal expansion of the double, then half-even at `digits`.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
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
  if (mantissa === 0n) return negative ? '-0' : '0';
  let intDigits: bigint;
  let scale: number;
  if (e >= 0) {
    intDigits = mantissa << BigInt(e);
    scale = 0;
  } else {
    intDigits = mantissa * 5n ** BigInt(-e);
    scale = -e;
  }
  // value = intDigits / 10^scale ; want round(value * 10^digits)
  let q: bigint;
  if (scale <= digits) q = intDigits * 10n ** BigInt(digits - scale);
  else {
    const div = 10n ** BigInt(scale - digits);
    q = intDigits / div;
    const rem = intDigits % div;
    const twice = rem * 2n;
    if (twice > div || (twice === div && q % 2n === 1n)) q += 1n;
  }
  const text = q.toString();
  const body =
    digits > 0
      ? `${text.padStart(digits + 1, '0').slice(0, -digits)}.${text.padStart(digits + 1, '0').slice(-digits)}`
      : text;
  return (negative ? '-' : '') + body;
}
