import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../common/assets/assets-root';
import { parsePyYamlDesign } from '../topologies/library/pyyaml-schema';
import {
  applyParameterUpdates,
  designParameters,
  syncedDecks,
} from './design-values';
import type { Dict } from './netlist/py';

interface Vector {
  topology: string;
  edits: Array<[string, string, string]>;
  analysis_cirs: Record<string, string>;
}

const vectors = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'sync',
      'vectors.json',
    ),
    'utf8',
  ),
) as Vector[];

const load = (topology: string): Dict =>
  parsePyYamlDesign(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
    topology,
  ) as Dict;

describe('design values (core sync_parameters parity)', () => {
  it.each(vectors.map((v) => [v.topology, v] as const))(
    '%s decks match core',
    (topology, vector) => {
      const design = load(topology);
      const updates = new Map<string, Map<string, string>>();
      for (const [ref, param, value] of vector.edits) {
        const params = updates.get(ref) ?? new Map<string, string>();
        params.set(param, value);
        updates.set(ref, params);
      }
      applyParameterUpdates(design, updates);
      expect(syncedDecks(design)).toEqual(vector.analysis_cirs);
    },
  );

  it('lists the main library values of a design', () => {
    const rows = designParameters(load('dcdc_buck'));
    expect(rows).toContainEqual({
      ref: 'L1',
      param: 'inductance',
      before: '4.7e-05',
      after: '4.7e-05',
      unit: 'H',
    });
    expect(rows.map((r) => `${r.ref}.${r.param}`)).toEqual([
      'VIN.voltage',
      'L1.inductance',
      'Cout.capacitance',
      'R_LOAD.resistance',
      'PWM.frequency',
      'PWM.duty_cycle',
    ]);
  });
});
