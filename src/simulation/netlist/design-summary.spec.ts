import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { parsePyYamlDesign } from '../../topologies/library/pyyaml-schema';
import { parseMeasurements } from '../results/measurements';
import {
  DESIGN_TAG,
  applyDesignSummary,
  designSummaryLine,
} from './design-summary';
import { generateAnalysisCirs } from './netlist-generator';
import type { Dict } from './py';
import { alignWindowToLineCycles, detectPwmPeriod, parseValue } from './timing';

const load = (topology: string): Dict =>
  parsePyYamlDesign(
    readFileSync(
      join(ASSETS_ROOT, 'topologies', 'primitives', `${topology}.yaml`),
      'utf8',
    ),
    topology,
  ) as Dict;

const criteriaOf = (design: Dict, rid: string): unknown => {
  const reqs = (design.analysis as Dict).transient as Dict;
  return (reqs.requirements as Dict[]).find((r) => r.rid === rid)?.criteria;
};

describe('design summary deck comment', () => {
  it('carries designed targets and referenced parameters to a template re-run', () => {
    const designed = load('dcdc_flyback');
    const target = criteriaOf(designed, 'tr_reg') as Dict;
    target.target_vout = 48n;
    const pwm = (designed.components as Dict[]).find(
      (c) => c.ref === 'PWM',
    ) as Dict;
    (pwm.params as Dict).duty_cycle = 0.4;

    const decks = generateAnalysisCirs(designed, 'all').analysis_cirs;
    const transient = decks.transient ?? '';
    expect(transient.split('\n')[1]).toBe(designSummaryLine(designed));
    expect(transient.split('\n')[1].startsWith(DESIGN_TAG)).toBe(true);

    const template = load('dcdc_flyback');
    expect(applyDesignSummary(template, Object.values(decks))).toBe(true);
    // Integers stay integers (YAML ints are bigint), floats stay floats.
    expect(criteriaOf(template, 'tr_reg')).toEqual(
      expect.objectContaining({ target_vout: 48n }),
    );
    const applied = (template.components as Dict[]).find(
      (c) => c.ref === 'PWM',
    ) as Dict;
    expect((applied.params as Dict).duty_cycle).toBe(0.4);
  });

  it('leaves the design alone without a summary line', () => {
    const template = load('dcdc_buck');
    const before = JSON.stringify(template, (_k, v: unknown) =>
      typeof v === 'bigint' ? `${v}n` : v,
    );
    expect(applyDesignSummary(template, ['* title\nR1 a b 1', null])).toBe(
      false,
    );
    expect(
      JSON.stringify(template, (_k, v: unknown) =>
        typeof v === 'bigint' ? `${v}n` : v,
      ),
    ).toBe(before);
  });
});

describe('simulation timing', () => {
  it('parses SPICE suffixes', () => {
    expect(parseValue('30m')).toBeCloseTo(0.03);
    expect(parseValue('10k')).toBe(10000);
    expect(parseValue('2meg')).toBe(2e6);
    expect(parseValue(5n)).toBe(5);
    expect(parseValue('abc')).toBeNull();
  });

  it('finds the PWM period of a carrier source', () => {
    expect(
      detectPwmPeriod({
        components: [
          {
            ref: 'VTRI',
            role: 'pwm_carrier',
            params: { spice_line: 'VTRI tri 0 PULSE(0 1 0 5u 5u 0 10u)' },
          },
        ],
      }),
    ).toBeCloseTo(1e-5);
    expect(detectPwmPeriod({ components: [] })).toBeNull();
  });

  it('stretches AVG windows to whole line cycles', () => {
    expect(
      alignWindowToLineCycles('avg v(out)', '0.024', '0.03', 1 / 160),
    ).toEqual(['0.02375', '0.03']);
    expect(
      alignWindowToLineCycles('max v(out)', '0.024', '0.03', 1 / 160),
    ).toEqual(['0.024', '0.03']);
  });
});

describe('measurement echo', () => {
  it('keeps the meas value when the print echo was cut', () => {
    const log = [
      'No. of Data Rows : 100',
      'vout_avg            =  3.810305e+02 from=  1.200000e-02 to=  1.500000e-02',
      'vout_avg = 3.8',
      'Reset',
    ].join('\n');
    expect(parseMeasurements(log).get('vout_avg')).toBeCloseTo(381.0305);
  });

  it('lets an agreeing echo refine the value', () => {
    const log = [
      'No. of Data Rows : 100',
      'vout_avg            =  3.810305e+02',
      'vout_avg = 3.81030512e+02',
    ].join('\n');
    expect(parseMeasurements(log).get('vout_avg')).toBe(381.030512);
  });
});
