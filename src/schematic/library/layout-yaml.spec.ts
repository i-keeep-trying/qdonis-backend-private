import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYaml } from '../../topologies/library/pyyaml-schema';
import { libraryLayout } from './layout';
import { layoutToYaml, replaceSchematicSection } from './layout-yaml';

const DIR = join(ASSETS_ROOT, 'topologies', 'primitives');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

describe('DEV-LAYOUT layout YAML writer', () => {
  // The library sections were written by the core's layout_to_yaml: writing
  // the parsed layout again must give the file back byte for byte.
  it.each(files)('rewrites %s identically', (file) => {
    const text = readFileSync(join(DIR, file), 'utf8');
    const circuit = parsePyYaml(text, file) as Record<string, unknown>;
    const layout = libraryLayout(circuit);
    expect(layout).not.toBeNull();
    const tuned = Boolean((circuit.schematic as Record<string, unknown>).tuned);
    expect(
      replaceSchematicSection(text, layoutToYaml(layout ?? {}, tuned)),
    ).toBe(text);
  });

  it('appends a section to a file without one and quotes what is not a plain key', () => {
    const section = layoutToYaml({
      components: {
        '~VOUT@L1.B': {
          x: 10.004,
          y: -0,
          rotation: 450,
          mirrorX: true,
          mirrorY: false,
        },
      },
      wires: [
        {
          id: 'W1',
          from: { type: 'pin', compId: 'L1', terminal: 'B' },
          to: { type: 'wire', wireId: 'W0', x: 1.5, y: 2 },
        },
      ],
      groups: { loop: { label: 'Voltage µ loop', members: ['R 1'] } },
    });
    expect(section).toBe(
      [
        'schematic:',
        '  tuned: true',
        '  components:',
        '    "~VOUT@L1.B": {x: 10.0, y: 0, rotation: 90, mirrorX: true}',
        '  wires:',
        '  - {id: W1, from: L1.B, to: {wire: W0, x: 1.5, y: 2}}',
        '  groups:',
        '    loop: {label: "Voltage \\u00b5 loop", members: ["R 1"]}',
        '',
      ].join('\n'),
    );
    expect(replaceSchematicSection('id: x\nname: y', section)).toBe(
      `id: x\nname: y\n${section}`,
    );
    expect(
      replaceSchematicSection(
        'a: 1\nschematic:\n  tuned: false\nb: 2\n',
        section,
      ),
    ).toBe(`a: 1\n${section}b: 2\n`);
  });
});
