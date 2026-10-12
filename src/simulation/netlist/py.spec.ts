import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pyEvalStr } from './py-eval';
import { floatRepr, formatFixed, formatG, roundInt } from './py';

interface Vectors {
  numbers: Array<{
    bits: string;
    g6: string;
    repr: string;
    f1: string;
    f3: string;
    round?: string;
  }>;
  evals: Array<{ expr: string; str?: string; error?: string }>;
}

const vectors = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'netlist-py',
      'vectors.json',
    ),
    'utf8',
  ),
) as Vectors;

const fromBits = (hex: string) => Buffer.from(hex, 'hex').readDoubleLE(0);

describe('Python number semantics (vectors from CPython)', () => {
  it('formats like format(x, ".6g"), repr(x), ".1f", ".3f" and round(x)', () => {
    const mismatches: string[] = [];
    for (const row of vectors.numbers) {
      const v = fromBits(row.bits);
      const got = {
        g6: formatG(v, 6),
        repr: floatRepr(v),
        f1: formatFixed(v, 1),
        f3: formatFixed(v, 3),
      };
      for (const key of ['g6', 'repr', 'f1', 'f3'] as const) {
        if (got[key] !== row[key])
          mismatches.push(
            `${key}(${row.repr}) = ${got[key]}, want ${row[key]}`,
          );
      }
      if (row.round !== undefined && roundInt(v).toString() !== row.round) {
        mismatches.push(
          `round(${row.repr}) = ${roundInt(v)}, want ${row.round}`,
        );
      }
    }
    expect(vectors.numbers.length).toBeGreaterThan(3000);
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  it('evaluates spice-command arithmetic like eval()', () => {
    for (const { expr, str, error } of vectors.evals) {
      if (error) expect(() => pyEvalStr(expr)).toThrow();
      else expect(`${expr} = ${pyEvalStr(expr)}`).toBe(`${expr} = ${str}`);
    }
  });

  it('refuses anything but arithmetic', () => {
    for (const expr of [
      '__import__("os")',
      'open("x")',
      'a.b',
      'x',
      '[1]',
      '"s"',
      'lambda: 1',
      '1 if 1 else 2',
    ]) {
      expect(() => pyEvalStr(expr)).toThrow();
    }
  });
});
