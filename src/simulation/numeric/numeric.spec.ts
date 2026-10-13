import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pandasFloat } from './pandas-float';
import { pyRound } from './numpy';

interface FloatVector {
  t: string;
  bits: string;
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
      'pandas-floats.json',
    ),
    'utf8',
  ),
) as FloatVector[];

const bitsOf = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value, 0);
  return buffer.toString('hex');
};

describe('pandas float parsing (vectors from pandas.read_csv)', () => {
  it('parses every token to the same double pandas produces', () => {
    const mismatches = vectors
      .filter(({ t, bits }) => {
        const got = pandasFloat(t);
        const want = Buffer.from(bits, 'hex').readDoubleLE(0);
        return Number.isNaN(want) ? !Number.isNaN(got) : bitsOf(got) !== bits;
      })
      .map(({ t }) => `${t} -> ${pandasFloat(t)}`);
    expect(vectors.length).toBeGreaterThan(20000);
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it('rounds like Python round(x, n)', () => {
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(0.12345, 4)).toBe(0.1235);
    expect(pyRound(-0.00005, 4)).toBe(-0.0001);
    expect(pyRound(1.00005, 4)).toBe(1.0001);
  });
});
