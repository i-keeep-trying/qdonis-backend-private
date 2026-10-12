/**
 * Simulation pipeline parity with qdonis-core (real ngspice; slow).
 *
 *   $env:SIM_PARITY='1'; npm test -- simulation.parity --maxConcurrency=6
 *
 * Optional: SIM_PARITY_ONLY=dcdc_buck,dcdc_boost and NGSPICE_PATH.
 * Fixtures come from test/parity/capture/simulation_capture.py (Windows run:
 * the captured CSV / log hashes are of CRLF text, so ours are compared as CRLF).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../common/assets/assets-root';
import { parsePyYamlDesign } from '../topologies/library/pyyaml-schema';
import { runRerun } from './rerun.pipeline';

interface SimulationFixture {
  topology: string;
  decks: Record<string, string>;
  measurements: Record<string, number>;
  results: unknown;
  plots: unknown;
  device_types: unknown;
  loss_analysis: unknown;
  time_series: Record<string, string>;
}

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  'test',
  'parity',
  'fixtures',
  'simulation',
);
const enabled = process.env.SIM_PARITY === '1';
const only = (process.env.SIM_PARITY_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ngspice = {
  // The console build, like qdonis-core: its `print` output (fewer digits)
  // overrides `.meas` values, so the GUI ngspice.exe gives other numbers.
  executable: process.env.NGSPICE_PATH ?? 'D:\\Spice64\\bin\\ngspice_con.exe',
  timeoutSeconds: 900,
};

const fixtures: SimulationFixture[] = enabled
  ? readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !only.length || only.includes(f.slice(0, -5)))
      .sort()
      .map(
        (f) =>
          JSON.parse(
            readFileSync(join(FIXTURES, f), 'utf8'),
          ) as SimulationFixture,
      )
  : [];

/** JSON-shaped copy: Maps -> objects, bigint -> number, undefined dropped. */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Map) return plain(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = plain(v);
    }
    return out;
  }
  return value;
}

/** Paths where `actual` differs from `expected` (first `limit`). */
function diff(
  actual: unknown,
  expected: unknown,
  path = '$',
  out: string[] = [],
  limit = 12,
): string[] {
  if (out.length >= limit) return out;
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (!(
      actual === expected ||
      (Number.isNaN(actual) && Number.isNaN(expected))
    )) {
      out.push(`${path}: ${actual} != ${expected}`);
    }
    return out;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      out.push(`${path}: length ${actual.length} != ${expected.length}`);
      return out;
    }
    actual.forEach((v, i) => diff(v, expected[i], `${path}[${i}]`, out, limit));
    return out;
  }
  if (
    actual &&
    expected &&
    typeof actual === 'object' &&
    typeof expected === 'object' &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) out.push(`${path}.${k}: missing`);
      else if (!(k in e)) out.push(`${path}.${k}: unexpected`);
      else diff(a[k], e[k], `${path}.${k}`, out, limit);
    }
    return out;
  }
  if (actual !== expected) {
    out.push(
      `${path}: ${JSON.stringify(actual)?.slice(0, 120)} != ${JSON.stringify(expected)?.slice(0, 120)}`,
    );
  }
  return out;
}

const crlfHash = (data: Buffer): string =>
  createHash('sha256')
    .update(data.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8')
    .digest('hex');

const describeIf = enabled ? describe : describe.skip;

describeIf('simulation pipeline parity with qdonis-core', () => {
  jest.setTimeout(1_800_000);

  it.concurrent.each(fixtures.map((f) => [f.topology, f] as const))(
    '%s',
    async (topology, fixture) => {
      const yamlData = parsePyYamlDesign(
        readFileSync(
          join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
          'utf8',
        ),
        topology,
      );
      const result = await runRerun(
        {
          topologyId: topology,
          yamlData,
          analysisCirs: fixture.decks,
          componentModels: {},
          junctionTemperature: 100.0,
        },
        ngspice,
      );

      const hashes: Record<string, string> = {};
      for (const [name, data] of Object.entries(result.timeSeries)) {
        hashes[name] = crlfHash(data);
      }
      const problems = {
        results: diff(plain(result.results), fixture.results),
        plots: diff(plain(result.plots), fixture.plots),
        loss_analysis: diff(plain(result.loss_analysis), fixture.loss_analysis),
        time_series: diff(hashes, fixture.time_series),
      };
      expect(problems).toEqual({
        results: [],
        plots: [],
        loss_analysis: [],
        time_series: [],
      });
    },
  );
});
