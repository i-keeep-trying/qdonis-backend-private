/**
 * Chat-first Magnetics / Thermal additions (old frontend 6d59ca0 / cab4f1f):
 * nested-resistor losses, R_ISO exclusion, the cooling recommendation and the
 * converter operating point of the magnetics estimates.
 */

import { analyzeThermal } from '../engines/thermal/thermal-engine';
import type {
  ComponentWaveStats,
  CircuitInventory,
  WaveformStats,
  WaveSummary,
} from './circuit-data.provider';
import {
  buildOperatingPoint,
  estimatePart,
  operatingPointRows,
} from './magnetics-operating-point';
import { passiveLosses } from './thermal.stage';

const wave = (rms: number, pp: number): WaveSummary => ({
  avg: 0,
  rms,
  ac_rms: rms,
  peak: pp / 2,
  max: pp / 2,
  min: -pp / 2,
  pp,
});

const stats = (
  components: Record<string, ComponentWaveStats>,
): WaveformStats => ({
  fsw: 100e3,
  line_frequency: null,
  window: { start: 0, span: 1e-4, basis: '10 periods', duration: 1e-3 },
  dt: 1e-8,
  samples_per_period: 1000,
  components,
});

describe('thermal: nested resistors and ground anchors', () => {
  // Flyback transformer T1 (n = 0.25) with an RC snubber on each side.
  const flyback = stats({
    T1: {
      type: 'transformer',
      params: { turns_ratio: 0.25 },
      v: wave(200, 400),
    },
    RSN_P: {
      type: 'resistor',
      parent: 'T1',
      params: { resistance: 22 },
      links: [
        ['T1', 'P2'],
        ['CSN_P', 'pos'],
      ],
    },
    CSN_P: {
      type: 'capacitor',
      parent: 'T1',
      params: { capacitance: 1e-9 },
      links: [
        ['RSN_P', 'neg'],
        ['T1', 'P1'],
      ],
    },
    RSN_S: {
      type: 'resistor',
      parent: 'T1',
      params: { resistance: 10 },
      links: [
        ['T1', 'S1'],
        ['CSN_S', 'pos'],
      ],
    },
    CSN_S: {
      type: 'capacitor',
      parent: 'T1',
      params: { capacitance: 2.2e-9 },
      links: [
        ['RSN_S', 'neg'],
        ['T1', 'S2'],
      ],
    },
    R_ISO: {
      type: 'resistor',
      role: 'secondary_ground_anchor',
      params: { resistance: 1e8 },
    },
  });
  const out = passiveLosses(flyback, new Set(['t1']), 100e3);
  const loss = (ref: string) => out.passives.find((p) => p.ref === ref);

  it("uses each snubber's own capacitor and the side it spans", () => {
    // C·ΔV²·fsw·tanh(T/4RC): primary ΔV = 400 V, secondary n·ΔV = 100 V.
    const primary =
      1e-9 * 400 ** 2 * 100e3 * Math.tanh(1 / (4 * 100e3 * 22 * 1e-9));
    const secondary =
      2.2e-9 * 100 ** 2 * 100e3 * Math.tanh(1 / (4 * 100e3 * 10 * 2.2e-9));
    expect(loss('RSN_P')?.lossW).toBeCloseTo(primary, 9);
    expect(loss('RSN_S')?.lossW).toBeCloseTo(secondary, 9);
    expect(loss('RSN_S')?.method).toContain('T1 secondary');
  });

  it('leaves the R_ISO ground anchor out of the budget', () => {
    expect(loss('R_ISO')).toBeUndefined();
    expect(out.excluded).toEqual([
      'R_ISO (100 MΩ simulation-only ground anchor for the isolated side, not a real part)',
    ]);
  });

  it('asks for a re-run when a nested part cannot be resolved', () => {
    const bare = passiveLosses(
      stats({
        T1: { type: 'transformer', params: {}, v: wave(10, 20) },
        RX: { type: 'resistor', parent: 'T1', params: { resistance: 5 } },
      }),
      new Set(['t1']),
      100e3,
    );
    expect(bare.notEvaluated).toEqual([
      {
        ref: 'RX',
        reason:
          'no waveform for this nested part — re-run the design and simulation to export it',
      },
    ]);
  });
});

describe('thermal: cooling recommendation', () => {
  const run = (lossW: number) =>
    analyzeThermal(
      [{ ref: 'Q1', kind: 'switch', lossW, technology: 'SiC' }],
      [],
      [],
      [],
      { ambientC: 40 },
    );

  it('needs no heatsink for a small loss', () => {
    const r = run(1);
    expect(r.heatsink).toBeNull();
    expect(r.cooling.tier).toBe('none');
  });

  it('sizes a heatsink from the required Rθsa', () => {
    const r = run(30);
    expect(r.heatsink?.feasible).toBe(true);
    expect(r.cooling.heatsink?.rsaMaxCW).toBeCloseTo(
      r.heatsink!.rsaRequired,
      9,
    );
    expect(r.cooling.heatsink?.volumeCm3).toBeGreaterThan(0);
    expect(['natural', 'natural_large', 'forced_air']).toContain(
      r.cooling.tier,
    );
  });

  it('falls back to liquid cooling when no shared sink is enough', () => {
    const r = run(400);
    expect(r.heatsink?.feasible).toBe(false);
    expect(r.cooling.tier).toBe('liquid');
  });
});

describe('magnetics: operating point estimates', () => {
  const inventory: CircuitInventory = {
    components: [],
    magnetics: [
      {
        ref: 'L1',
        type: 'inductor',
        role: 'output_inductor',
        inductance: 22e-6,
      },
    ],
    switching_frequency: 200e3,
    input_voltage: 48,
    power_sources: [
      { ref: 'VIN', role: 'input_source', kind: 'dc', value: 48 },
    ],
    output_voltage: { value: 12, rms: false, key: 'target_vout' },
    load_resistance: 1.2,
  };

  it('takes Vin, Vout and Pout from the circuit when the specs have none', () => {
    const op = buildOperatingPoint({
      topologyId: 'dcdc_buck',
      specs: null,
      inventory,
      fsw: 200e3,
      fswSource: 'circuit',
    });
    expect(op).toMatchObject({
      family: 'buck',
      vinMin: 48,
      vout: 12,
      pout: 120,
    });
    expect(operatingPointRows(op).map((r) => r.label)).toEqual([
      'Vin',
      'Vout',
      'Pout',
      'Efficiency',
      'fsw',
    ]);
  });

  it('builds the buck inductor current from the volt-seconds', () => {
    const op = buildOperatingPoint({
      topologyId: 'dcdc_buck',
      specs: null,
      inventory,
      fsw: 200e3,
      fswSource: 'circuit',
    });
    const est = estimatePart(
      inventory.magnetics[0],
      inventory.magnetics,
      op,
      'dcdc_buck',
      'inductor',
    );
    expect(est).not.toBeNull();
    // ΔI = (Vin − Vout)·D/(L·fsw) with D = 0.25: 36·0.25/(22 µH·200 kHz) ≈ 2.05 A.
    const ripple = est!.inputs.rows.find((r) => r.label === 'ΔI_L (p-p)');
    expect(ripple?.value).toBe('2.05 A');
    expect(est!.inputs.basis).toContain('Buck output inductor · CCM');
  });
});
