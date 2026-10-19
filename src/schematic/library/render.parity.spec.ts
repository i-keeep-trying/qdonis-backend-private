import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYamlDesign } from '../../topologies/library/pyyaml-schema';
import type { SchematicLayout } from '../schematic.types';
import { renderForTopology } from './render';
import { paletteForEngine, symbolsForEngine } from './symbols';

interface RenderCase {
  name: string;
  sheet: string | null;
  layout: SchematicLayout | null;
  fresh?: boolean;
  regroup?: boolean;
  result: Record<string, unknown>;
}

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'parity',
  'fixtures',
  'schematic',
);

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as T;

const topologies = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => read<{ topology: string; cases: RenderCase[] }>(f));

const circuitOf = (topology: string) =>
  parsePyYamlDesign(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
    topology,
  ) as Record<string, unknown>;

const drawingOf = (topology: string) =>
  JSON.parse(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'json_library', `${topology}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>;

/** What the engine receives (JSON): drops undefined, turns -0 into 0. */
const asJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

describe('schematic render parity with qdonis-core schematic_sync.py', () => {
  it('has a fixture for every library topology', () => {
    expect(topologies).toHaveLength(35);
  });

  it('sends the same symbol table and palette to the engine', () => {
    const fixture = read<{ palette: unknown; symbols: unknown }>(
      '_static.json',
    );
    expect(asJson(symbolsForEngine())).toEqual(fixture.symbols);
    expect(asJson(paletteForEngine())).toEqual(fixture.palette);
  });

  describe.each(topologies.map((t) => [t.topology, t] as const))(
    '%s',
    (topology, { cases }) => {
      it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const result = renderForTopology(circuitOf(topology), {
          layout: c.layout,
          sheet: c.sheet,
          fresh: c.fresh,
          regroup: c.regroup,
          drawing: drawingOf(topology),
        });
        const { palette, ...rest } = result;
        delete rest.schematic.symbols;
        expect(palette).toBeDefined();
        expect(asJson(rest)).toEqual(c.result);
      });
    },
  );
});
