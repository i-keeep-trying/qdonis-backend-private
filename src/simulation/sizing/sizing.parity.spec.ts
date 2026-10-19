/**
 * Sizing (topology_improver) parity with qdonis-core on canned model replies:
 * prompts, post-processing, DAB/AFE adapters, YAML application, change list,
 * quick-params line and the resulting decks. Fixtures:
 * test/parity/capture/sizing_capture.py.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYamlDesign } from '../../topologies/library/pyyaml-schema';
import { generateAnalysisCirs } from '../netlist/netlist-generator';
import type { Dict } from '../netlist/py';
import { sortedSummaryParams } from '../../../test/parity/design-summary';
import {
  buildChangeList,
  buildQuickParamsLine,
  jsonLoadsPy,
  prepareSizing,
  processReply,
  type SizingOutcome,
} from './sizing.logic';
import { sizingSystemPrompt } from './sizing.prompts';

interface Case {
  topology: string;
  params: Dict;
  reply: string | null;
  system: string | null;
  user: string | null;
  temperature: number | null;
  updates: unknown;
  reasoning: string | null;
  changes: unknown;
  quick: string;
  decks: Record<string, string>;
}

const fixture = jsonLoadsPy(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'sizing',
      'vectors.json',
    ),
    'utf8',
  ),
) as { system_base: string; cases: Case[] };

const template = (topology: string): Dict =>
  parsePyYamlDesign(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
    topology,
  ) as Dict;

/** Deep equality keeping Python int (bigint) apart from float (number). */
function diff(
  a: unknown,
  e: unknown,
  path = '$',
  out: string[] = [],
): string[] {
  if (out.length >= 10) return out;
  if (typeof a !== typeof e) {
    out.push(`${path}: ${typeof a} ${String(a)} != ${typeof e} ${String(e)}`);
  } else if (Array.isArray(a) && Array.isArray(e)) {
    if (a.length !== e.length)
      out.push(`${path}: length ${a.length} != ${e.length}`);
    else a.forEach((v, i) => diff(v, e[i], `${path}[${i}]`, out));
  } else if (a && e && typeof a === 'object') {
    const ka = Object.keys(a);
    const ke = Object.keys(e);
    if (ka.join('|') !== ke.join('|'))
      out.push(`${path}: keys ${ka.join(',')} != ${ke.join(',')}`);
    else
      for (const k of ka)
        diff((a as Dict)[k], (e as Dict)[k], `${path}.${k}`, out);
  } else if (!Object.is(a, e) && a !== e) {
    out.push(
      `${path}: ${JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))} != ${JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))}`,
    );
  }
  return out;
}

describe('sizing parity with qdonis-core', () => {
  it('builds the same system prompt', () => {
    expect(sizingSystemPrompt(null)).toBe(fixture.system_base);
  });

  it.each(fixture.cases.map((c, i) => [`${c.topology} #${i % 2}`, c] as const))(
    '%s',
    (_name, c) => {
      const yamlTemplate = template(c.topology);
      const prepared = prepareSizing(
        structuredClone(yamlTemplate),
        structuredClone(c.params),
      );
      let outcome: SizingOutcome;
      if ('outcome' in prepared) {
        expect(c.user).toBeNull();
        outcome = prepared.outcome;
      } else {
        expect(prepared.user).toBe(c.user);
        expect(
          sizingSystemPrompt(c.topology).slice(fixture.system_base.length),
        ).toBe(c.system);
        outcome = processReply(
          c.reply ?? '',
          prepared.yaml,
          yamlTemplate,
          prepared.params,
        );
      }
      const updates = Object.keys(outcome.updates).length
        ? outcome.updates
        : {};
      expect(diff(updates, c.updates)).toEqual([]);
      expect(outcome.reasoning).toBe(c.reasoning);
      const changes = Object.keys(outcome.updates).length
        ? buildChangeList(yamlTemplate, outcome.updates, c.params)
        : [];
      expect(diff(changes, c.changes)).toEqual([]);
      expect(buildQuickParamsLine(c.topology, c.params, changes)).toBe(c.quick);
      // Which ground member names an auto-grounded net, and the order of the
      // design summary's parameters, depend on Python's hash seed (see
      // netlist.parity.spec.ts).
      const normalize = (decks: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(decks).map(([k, v]) => [
            k,
            sortedSummaryParams(v).replace(
              /^(\* Auto-grounded net \d+) due to .*$/gm,
              '$1',
            ),
          ]),
        );
      expect(
        normalize(generateAnalysisCirs(outcome.yaml, 'all').analysis_cirs),
      ).toEqual(normalize(c.decks));
    },
  );
});
