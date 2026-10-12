import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Dict } from './netlist/py';
import {
  lossAnalysisView,
  measurementGroups,
  storedWaveforms,
  unitOf,
  waveformSet,
} from './simulation.format';
import type { RerunResult } from './rerun.pipeline';

const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'simulation',
      'dcdc_buck.json',
    ),
    'utf8',
  ),
) as {
  results: Dict;
  plots: Record<string, Dict>;
  loss_analysis: RerunResult['loss_analysis'];
};

describe('simulation stage format', () => {
  it('groups requirement outputs by analysis with units', () => {
    const groups = measurementGroups(fixture.results);
    expect(groups.map((g) => `${g.analysis}/${g.key}`)).toEqual([
      'transient/tr_dyn',
      'transient/tr_eff',
      'transient/tr_reg',
      'transient/tr_stress',
    ]);
    const reg = groups.find((g) => g.key === 'tr_reg')!;
    expect(reg.measurements).toContainEqual({
      name: 'vout_avg_v',
      value: 5.348791,
      unit: 'V',
      kind: 'output',
      target: null,
      status: 'info',
    });
    expect(unitOf('efficiency_pct')).toBe('%');
    expect(unitOf('settle_time')).toBeNull();
  });

  it('marks outputs checked by a feasibility constraint', () => {
    const results: Dict = {
      dc: {
        feasibility: {
          constraints: [
            { constraint_id: 'vout_v', status: 'fail', target_value: 12 },
          ],
        },
        dc_op: { title: 'OP', outputs: { vout_v: { value: 11.2 } } },
      },
    };
    expect(measurementGroups(results)[0].measurements[0]).toMatchObject({
      target: '12',
      status: 'fail',
    });
  });

  it('turns Plotly payloads into waveform plots and reads them back', () => {
    const set = waveformSet(fixture.plots);
    const plot = set.plots.V_SW;
    expect(plot).toMatchObject({ key: 'V_SW', analysis: 'transient' });
    expect(plot.x.length).toBe(plot.y.length);
    expect(plot.x.length).toBe(
      (fixture.plots.V_SW as { pointCount: number }).pointCount,
    );
    expect(storedWaveforms({ plots: set.plots })).toEqual(set);
    expect(storedWaveforms({ plots: fixture.plots })).toEqual(set);
  });

  it('maps the loss engine rows', () => {
    const view = lossAnalysisView(fixture.loss_analysis)!;
    expect(view.junctionTemperatureC).toBe(100);
    expect(view.components[0]).toMatchObject({
      component: 'D',
      deviceType: 'diode',
      totalLossW: 0.2536,
    });
  });
});
