/**
 * Python-compatible serialisation helpers. The Studio system prompt embeds a
 * JSON snapshot and tool results embed scalars exactly as qdonis-core printed
 * them (`json.dumps(..., ensure_ascii=False)`, `str()`), so the model sees
 * byte-identical text after the migration.
 *
 * Numbers: the frontend serialises with JS, so a value whose JS text is a
 * plain integer (`5`, `100000000000000000000`) reaches Python as an `int`
 * and is printed as-is; anything with a fraction or exponent becomes a
 * Python `float` and is printed with Python's `repr`.
 */

/**
 * Python `repr(float)`: shortest round-trip digits; scientific notation when
 * the decimal exponent is < -4 or >= 16, exponent with sign and at least two
 * digits (`1e-05`, `1.5e+22`); fixed notation keeps a `.0` on integers.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';

  const [mantissa, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const sign = negative ? '-' : '';

  if (exponent < -4 || exponent >= 16) {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? '-' : '+';
    const expDigits = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${head}e${expSign}${expDigits}`;
  }
  if (exponent < 0) {
    return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  const intLength = exponent + 1;
  if (digits.length <= intLength) {
    return `${sign}${digits.padEnd(intLength, '0')}.0`;
  }
  return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
}

/** A JS number as Python prints the value it decodes from the JS JSON text. */
export function pythonNumber(value: number): string {
  if (!Number.isFinite(value)) return pythonFloatRepr(value);
  const text = JSON.stringify(value);
  return /^-?\d+$/.test(text) ? text : pythonFloatRepr(value);
}

/**
 * `json.dumps(value, ensure_ascii=False)` with the default separators
 * (`", "` and `": "`). `undefined` object members are skipped and `undefined`
 * array items become `null`, as after a JSON round trip.
 */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pythonNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonDumps(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`);
    return `{${members.join(', ')}}`;
  }
  // Never produced by JSON decoding.
  if (typeof value === 'bigint') return value.toString();
  return 'null';
}

/** Python `str()` of a decoded JSON scalar (`None` maps to empty). */
export function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pythonNumber(value);
  if (typeof value === 'string') return value;
  return pythonJsonDumps(value);
}

/**
 * Python `str.strip()` whitespace (`str.isspace`): unlike JS `trim()` it
 * includes U+001C..U+001F and U+0085 and excludes U+FEFF.
 */
const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** {@link PY_SPACE} for building regex character classes (`[${PY_WHITESPACE}]`). */
export const PY_WHITESPACE = PY_SPACE;
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

export function pythonStrip(text: string): string {
  return text.replace(PY_STRIP, '');
}

/** Python `len(s) > limit: s[:limit] + suffix`, counted in code points. */
export function truncateCodePoints(
  text: string,
  limit: number,
  suffix: string,
): string {
  // Cheap exit: UTF-16 length is an upper bound of the code point count.
  if (text.length <= limit) return text;
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return points.slice(0, limit).join('') + suffix;
}
