import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYamlDesign } from '../../topologies/library/pyyaml-schema';
import { generateAnalysisCirs, generateNetlist } from './netlist-generator';
import type { Dict } from './py';
import { sortedSummaryParams as sortedParams } from '../../../test/parity/design-summary';

interface NetlistFixture {
  topology: string;
  netlist: string;
  controls: { dc: string; ac: string; transient: string };
  analysis_cirs: Record<string, string>;
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
  'netlist',
);

/**
 * Topologies whose core output depends on Python's hash seed (set iteration
 * order in `build_comp_nets`); the fixture is one of several valid outputs.
 */
const HASH_ORDER_DEPENDENT = new Set([
  'acdc_flyback_pfc_dcm',
  'dcdc_dual_active_bridge',
]);

const fixtures: NetlistFixture[] = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map(
    (file) =>
      JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as NetlistFixture,
  );

const loadDesign = (topology: string): Dict =>
  parsePyYamlDesign(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
    topology,
  ) as Dict;

/**
 * The only hash-order effect in these decks: which ground member the
 * "Auto-grounded net N due to REF:PIN" comment names. The circuit is the same.
 */
const normalize = (text: string) =>
  text.replace(/^(\* Auto-grounded net \d+) due to .*$/gm, '$1');

describe('netlist generator parity with qdonis-core', () => {
  it('has a fixture for every library topology', () => {
    expect(fixtures).toHaveLength(35);
    expect(fixtures.filter((f) => f.error)).toEqual([]);
  });

  describe.each(fixtures.map((f) => [f.topology, f] as const))(
    '%s',
    (topology, fixture) => {
      const exact = !HASH_ORDER_DEPENDENT.has(topology);

      it('builds the same base netlist and decks as /simulate/prepare', () => {
        const result = generateAnalysisCirs(loadDesign(topology), 'all');
        expect(Object.keys(result.analysis_cirs).sort()).toEqual(
          Object.keys(fixture.analysis_cirs).sort(),
        );
        const same = (actual: string, expected: string) =>
          exact
            ? expect(sortedParams(actual)).toBe(sortedParams(expected))
            : expect(normalize(sortedParams(actual))).toBe(
                normalize(sortedParams(expected)),
              );
        same(result.netlist, fixture.netlist);
        for (const [kind, deck] of Object.entries(fixture.analysis_cirs)) {
          same(result.analysis_cirs[kind as 'dc'] ?? '', deck);
        }
      });

      it('builds the same control blocks', () => {
        const { controls } = generateNetlist(loadDesign(topology), null);
        for (const kind of ['dc', 'ac', 'transient'] as const) {
          expect(controls[kind]).toBe(fixture.controls[kind]);
        }
      });
    },
  );
});
