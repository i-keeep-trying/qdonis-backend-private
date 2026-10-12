/**
 * Float parsing exactly as pandas `read_csv` does it (C engine, default
 * `float_precision`: `precise_xstrtod`). It is not correctly rounded: digits
 * are accumulated in a double (max 17) and scaled by one table power of ten,
 * so a correctly rounded parser (`Number()`) differs in the last bit for
 * about a fifth of ngspice's values. Matching it keeps loss and plot numbers
 * identical to qdonis-core.
 */

const POW10: number[] = Array.from({ length: 309 }, (_, k) => Number(`1e${k}`));

const NA_VALUES = new Set([
  '',
  '#N/A',
  '#N/A N/A',
  '#NA',
  '-1.#IND',
  '-1.#QNAN',
  '-NaN',
  '-nan',
  '1.#IND',
  '1.#QNAN',
  '<NA>',
  'N/A',
  'NA',
  'NULL',
  'NaN',
  'None',
  'n/a',
  'nan',
  'null',
]);

const isDigit = (code: number) => code >= 48 && code <= 57;

/** `precise_xstrtod` on a whole token; NaN when the token is not a number. */
export function pandasFloat(token: string): number {
  if (NA_VALUES.has(token)) return Number.NaN;
  const lowered = token.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(lowered)) {
    return lowered.startsWith('-') ? -Infinity : Infinity;
  }
  let p = 0;
  const n = token.length;
  let negative = false;
  if (token[p] === '-') {
    negative = true;
    p += 1;
  } else if (token[p] === '+') {
    p += 1;
  }
  let number = 0;
  let exponent = 0;
  let numDigits = 0;
  let numDecimals = 0;
  const maxDigits = 17;
  while (p < n && isDigit(token.charCodeAt(p))) {
    if (numDigits < maxDigits) {
      number = number * 10 + (token.charCodeAt(p) - 48);
      numDigits += 1;
    } else {
      exponent += 1;
    }
    p += 1;
  }
  if (token[p] === '.') {
    p += 1;
    while (numDigits < maxDigits && p < n && isDigit(token.charCodeAt(p))) {
      number = number * 10 + (token.charCodeAt(p) - 48);
      p += 1;
      numDigits += 1;
      numDecimals += 1;
    }
    if (numDigits >= maxDigits)
      while (p < n && isDigit(token.charCodeAt(p))) p += 1;
    exponent -= numDecimals;
  }
  if (numDigits === 0) return Number.NaN;
  if (negative) number = -number;
  if (p < n && (token[p] === 'e' || token[p] === 'E')) {
    p += 1;
    let expNegative = false;
    if (token[p] === '-') {
      expNegative = true;
      p += 1;
    } else if (token[p] === '+') {
      p += 1;
    }
    let value = 0;
    let any = false;
    while (p < n && isDigit(token.charCodeAt(p))) {
      value = value * 10 + (token.charCodeAt(p) - 48);
      p += 1;
      any = true;
    }
    if (!any) return Number.NaN;
    exponent += expNegative ? -value : value;
  }
  if (p !== n) return Number.NaN;
  if (exponent > 308) return negative ? -Infinity : Infinity;
  if (exponent > 0) number *= POW10[exponent];
  else if (exponent < -308) {
    if (exponent < -616) number = 0 * (negative ? -1 : 1);
    else {
      number /= POW10[-308 - exponent];
      number /= POW10[308];
    }
  } else {
    number /= POW10[-exponent];
  }
  return number;
}

/**
 * `pd.read_csv(path, sep=r'\s+', header=None)` for numeric ngspice data:
 * returns columns of float64. Rows with fewer fields are NaN-padded; the
 * column count is the widest row (pandas would error on a wider later row).
 */
export function readWhitespaceTable(text: string): number[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const fields = line.trim().split(/[ \t]+/);
    if (fields.length === 1 && fields[0] === '') continue;
    rows.push(fields);
  }
  if (rows.length === 0) throw new Error('No columns to parse from file');
  const width = rows[0].length;
  for (const row of rows) {
    if (row.length > width) {
      throw new Error(
        `Error tokenizing data. C error: Expected ${width} fields, saw ${row.length}`,
      );
    }
  }
  const columns: number[][] = Array.from({ length: width }, () => []);
  for (const row of rows) {
    for (let c = 0; c < width; c += 1) {
      columns[c].push(c < row.length ? pandasFloat(row[c]) : Number.NaN);
    }
  }
  return columns;
}
