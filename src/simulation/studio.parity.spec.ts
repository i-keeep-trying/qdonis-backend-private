/**
 * Waveform statistics, device selection and loss recalculation parity with
 * qdonis-core, on the time-series archives captured by
 * test/parity/capture/studio_capture.py (no ngspice needed).
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ASSETS_ROOT } from '../common/assets/assets-root';
import {
  catalogue,
  selectDevices,
  type Overrides,
} from './loss/device-selection';
import { circuitInventory } from '../circuits/library/circuit-inventory';
import { parsePyYaml } from '../topologies/library/pyyaml-schema';
import {
  calculateLosses,
  lossesVsTemperature,
  type DeviceKind,
} from './loss/loss-engine';
import type { Dict } from './netlist/py';
import { readZip } from './ngspice/zip';
import { waveformStats } from './waveforms/waveform-stats';

const DIR = join(__dirname, '..', '..', 'test', 'parity', 'fixtures', 'studio');

/** Python `json.dumps` may write NaN / Infinity; JSON.parse cannot read them. */
const parse = (text: string): unknown =>
  JSON.parse(
    text.replace(/(?<=[:[,]\s*)(-?Infinity|NaN)(?=\s*[,\]}])/g, '"__$1"'),
    (_key, value: unknown) =>
      value === '__NaN'
        ? Number.NaN
        : value === '__Infinity'
          ? Infinity
          : value === '__-Infinity'
            ? -Infinity
            : value,
  );
const load = (name: string) => parse(readFileSync(join(DIR, name), 'utf8'));

interface Fixture {
  topology: string;
  zip: string;
  device_types: Record<string, DeviceKind>;
  waveform_stats: unknown;
  selection: unknown;
  selection_losses: unknown;
  selection_igbt: unknown;
  override?: Overrides;
  selection_override?: unknown;
  recalc_150: unknown;
  loss_vs_temperature: unknown;
  error?: string;
}

/** Paths where `actual` differs from `expected` (first `limit`). */
function diff(
  actual: unknown,
  expected: unknown,
  path = '$',
  out: string[] = [],
): string[] {
  if (out.length >= 12) return out;
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (!(Object.is(actual, expected) || actual === expected))
      out.push(`${path}: ${actual} != ${expected}`);
    return out;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      out.push(`${path}: length ${actual.length} != ${expected.length}`);
      return out;
    }
    actual.forEach((v, i) => diff(v, expected[i], `${path}[${i}]`, out));
    return out;
  }
  if (
    actual &&
    expected &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    const a = actual as Dict;
    const e = expected as Dict;
    for (const k of [
      ...new Set([...Object.keys(a), ...Object.keys(e)]),
    ].sort()) {
      if (!(k in a)) out.push(`${path}.${k}: missing`);
      else if (!(k in e)) out.push(`${path}.${k}: unexpected`);
      else diff(a[k], e[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (actual !== expected) {
    out.push(
      `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
  return out;
}

/** JSON round trip, as core's output went through `json.dumps`. */
const plain = (value: unknown): unknown =>
  parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isFinite(v) ? `__${v}` : v,
    ).replace(/"__(NaN|-?Infinity)"/g, '$1'),
  );

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => load(f) as Fixture);

/** Plain YAML (numbers as JSON numbers), as `yaml.safe_load` gave core. */
const yamlOf = (topology: string): Dict =>
  parseYaml(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
  ) as Dict;

describe('studio data parity with qdonis-core', () => {
  it('lists the device catalogue in core order', () => {
    expect(diff(plain(catalogue()), load('_catalogue.json'))).toEqual([]);
  });

  it('circuit inventory of every library topology', () => {
    const expected = load('_inventory.json') as Record<string, unknown>;
    expect(Object.keys(expected).length).toBeGreaterThan(30);
    for (const [topology, inventory] of Object.entries(expected)) {
      const path = join(
        ASSETS_ROOT,
        'topologies',
        'primitives',
        `${topology}.yaml`,
      );
      const yaml = parsePyYaml(readFileSync(path, 'utf8'), path) as Dict;
      expect([
        topology,
        diff(plain(circuitInventory(yaml)), inventory),
      ]).toEqual([topology, []]);
    }
  });

  describe.each(fixtures.map((f) => [f.topology, f] as const))(
    '%s',
    (_topology, fx) => {
      let dir: string;
      beforeAll(() => {
        expect(fx.error).toBeUndefined();
        dir = mkdtempSync(join(tmpdir(), 'studio_parity_'));
        for (const entry of readZip(Buffer.from(fx.zip, 'base64'))) {
          writeFileSync(join(dir, entry.name), entry.data);
        }
      });
      afterAll(() => rmSync(dir, { recursive: true, force: true }));

      it('waveform stats', () => {
        expect(
          diff(
            plain(waveformStats(fx.zip, yamlOf(fx.topology))),
            fx.waveform_stats,
          ),
        ).toEqual([]);
      });

      it('device selection + losses of the chosen parts', () => {
        const sel = selectDevices(dir, 100.0, fx.device_types);
        expect(diff(plain(sel), fx.selection)).toEqual([]);
        expect(
          diff(
            plain(
              calculateLosses(
                dir,
                100.0,
                sel.component_models,
                fx.device_types,
              ),
            ),
            fx.selection_losses,
          ),
        ).toEqual([]);
        expect(
          diff(
            plain(
              calculateLosses(
                dir,
                150.0,
                sel.component_models,
                fx.device_types,
              ),
            ),
            fx.recalc_150,
          ),
        ).toEqual([]);
      });

      it('losses versus junction temperature', () => {
        const sel = selectDevices(dir, 100.0, fx.device_types);
        expect(
          diff(
            plain(
              lossesVsTemperature(dir, sel.component_models, fx.device_types),
            ),
            fx.loss_vs_temperature,
          ),
        ).toEqual([]);
      });

      it('IGBT preference and user overrides', () => {
        expect(
          diff(
            plain(selectDevices(dir, 100.0, fx.device_types, 'igbt')),
            fx.selection_igbt,
          ),
        ).toEqual([]);
        if (fx.override) {
          expect(
            diff(
              plain(
                selectDevices(dir, 100.0, fx.device_types, 'auto', fx.override),
              ),
              fx.selection_override,
            ),
          ).toEqual([]);
        }
      });
    },
  );
});
