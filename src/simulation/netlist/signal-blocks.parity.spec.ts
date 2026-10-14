import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Dict } from './py';
import {
  CONTROL_BLOCK_DEFAULTS,
  CONTROL_BLOCK_GLYPHS,
  CONTROL_BLOCK_TYPES,
  blockPins,
  controlBlockSymbolPins,
  describeControlBlock,
  emitControlBlock,
} from './signal-blocks';

interface BlockCase {
  ref: string;
  type: string;
  params: Dict;
  nets: Record<string, string>;
  pins?: { inputs: string[]; outputs: string[] };
  describe?: string;
  symbol_pins?: Record<string, unknown>;
  lines?: string[];
  error?: string;
}

interface Tables {
  defaults: Record<string, Dict>;
  labels: Record<string, string>;
  glyphs: Record<string, string>;
}

const records = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'control-blocks',
      'cases.json',
    ),
    'utf8',
  ),
) as Array<BlockCase | Tables>;

const cases = records.filter((r): r is BlockCase => 'ref' in r);
const tables = records.find((r): r is Tables => 'defaults' in r);

describe('control blocks parity with qdonis-core control_blocks.py', () => {
  it('has the same block types, defaults and glyphs', () => {
    expect(tables).toBeDefined();
    expect(CONTROL_BLOCK_TYPES).toEqual(tables?.labels);
    // Python ints are bigint here; JSON has plain numbers.
    const defaults = JSON.parse(
      JSON.stringify(CONTROL_BLOCK_DEFAULTS, (_k, v: unknown) =>
        typeof v === 'bigint' ? Number(v) : v,
      ),
    ) as unknown;
    expect(defaults).toEqual(tables?.defaults);
    expect(CONTROL_BLOCK_GLYPHS).toEqual(tables?.glyphs);
  });

  it.each(cases.map((c, i) => [`${i} ${c.ref} (${c.type})`, c] as const))(
    '%s',
    (_name, c) => {
      const nets = new Map(Object.entries(c.nets));
      if (c.error !== undefined) {
        expect(() => emitControlBlock(c.ref, c.type, c.params, nets)).toThrow(
          c.error,
        );
      } else {
        expect(emitControlBlock(c.ref, c.type, c.params, nets)).toEqual(
          c.lines,
        );
      }
      if (c.pins) expect(blockPins(c.type, c.params)).toEqual(c.pins);
      if (c.describe !== undefined) {
        expect(describeControlBlock(c.type, c.params)).toBe(c.describe);
      }
      if (c.symbol_pins) {
        expect(controlBlockSymbolPins(c.type, c.params)).toEqual(c.symbol_pins);
      }
    },
  );
});
