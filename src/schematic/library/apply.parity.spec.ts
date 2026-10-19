import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYamlDesign } from '../../topologies/library/pyyaml-schema';
import { applySchematic } from './apply';
import { readDrawing } from './drawing-input';
import { libraryLayout, mergeLayouts } from './layout';

interface ApplyCase {
  name: string;
  sheet: string | null;
  schematic: Record<string, unknown>;
  result?: Record<string, unknown> & {
    circuit: Record<string, unknown>;
    layout: Record<string, unknown>;
  };
  error?: string;
}

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'parity',
  'fixtures',
  'schematic-apply',
);

const topologies = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map(
    (f) =>
      JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as {
        topology: string;
        cases: ApplyCase[];
      },
  );

const asset = (...parts: string[]) =>
  readFileSync(join(ASSETS_ROOT, 'topologies', ...parts), 'utf8');

/** JSON as the core dumps it (YAML ints are bigint here). */
const asJson = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'bigint' ? Number(v) : v,
    ),
  ) as unknown;

describe('schematic apply parity with qdonis-core apply_schematic', () => {
  it('has a fixture for every library topology', () => {
    expect(topologies).toHaveLength(35);
  });

  describe.each(topologies.map((t) => [t.topology, t] as const))(
    '%s',
    (topology, { cases }) => {
      const circuit = () =>
        parsePyYamlDesign(
          asset('primitives', `${topology}.yaml`),
          topology,
        ) as Record<string, unknown>;
      const drawing = JSON.parse(
        asset('json_library', `${topology}.json`),
      ) as Record<string, unknown>;

      it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const base = circuit();
        const layout = mergeLayouts(libraryLayout(base), null, base);
        // Through the input check the API applies: it must not change what an edit means.
        const run = () =>
          applySchematic(
            base,
            readDrawing(structuredClone(c.schematic)),
            null,
            c.sheet,
            layout,
            drawing,
          );
        if (c.error !== undefined) {
          expect(run).toThrow(c.error.replace(/^\w+: /, ''));
          return;
        }
        const result = run();
        const expected = c.result as NonNullable<ApplyCase['result']>;
        // The YAML's schematic: section is never touched by an edit.
        expect(asJson(result.circuit.schematic)).toEqual(
          asJson(base.schematic),
        );
        delete result.circuit.schematic;
        const actual = asJson(result) as Record<string, unknown> & {
          layout: Record<string, unknown>;
        };
        if (!c.name.endsWith(':unchanged'))
          actual.layout = { groups: actual.layout.groups };
        // The input check drops wires' `hidden` flag (the render derives it again).
        const withoutHidden = JSON.parse(
          JSON.stringify(expected, (key, v: unknown) =>
            key === 'hidden' ? undefined : v,
          ),
        ) as unknown;
        expect(actual).toEqual(withoutHidden);
      });
    },
  );
});
