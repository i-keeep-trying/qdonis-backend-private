import { circuitInventory } from '../circuits/library/circuit-inventory';
import { ASSETS_ROOT } from '../common/assets/assets-root';
import {
  commitStage,
  createEmptyProject,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { loadTopologyCatalog } from '../topologies/library/topology-catalog.loader';
import type { TopologyCatalog } from '../topologies/topologies.types';
import type {
  CircuitDataProvider,
  CircuitInventory,
} from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';
import { type MtbfPart, planMtbf } from './mtbf.stage';

let catalog: TopologyCatalog;
beforeAll(async () => {
  catalog = await loadTopologyCatalog(ASSETS_ROOT);
});

/** The library inventory, as the real provider builds it. */
const provider = (): CircuitDataProvider => ({
  inventory: ({ topologyId }) =>
    Promise.resolve(
      circuitInventory(
        structuredClone(catalog.definitions.get(topologyId)) as never,
      ) as unknown as CircuitInventory,
    ),
  waveformStats: () => Promise.resolve(null),
  recalculateLosses: () => Promise.resolve(null),
});

const withCircuit = (topologyId: string): StudioProject =>
  commitStage(createEmptyProject(), 'visualization', { topologyId }).project;

function ok(plan: StagePlan) {
  if (!plan.ok) throw new Error(plan.result.summary);
  return plan;
}
const partsOf = (plan: StagePlan) => ok(plan).data.parts as MtbfPart[];
const resultOf = (plan: StagePlan) =>
  ok(plan).data.result as {
    mtbfHours: number | null;
    failureRateFit: number;
    components: Array<{ designator: string; partNumber: string }>;
    byMethod: Array<{ method: string; mtbfHours: number | null }>;
  };

describe('MTBF stage', () => {
  it('asks for parts when the branch has no circuit', async () => {
    const plan = await planMtbf(createEmptyProject(), {}, provider());
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.result.payload?.missing).toBe('parts');
  });

  it('evaluates the circuit parts and leaves the load out', async () => {
    const plan = await planMtbf(withCircuit('dcdc_buck'), {}, provider());
    const parts = partsOf(plan);
    expect(parts.map((p) => [p.ref, p.type, p.included])).toEqual([
      ['SW', 'mosfet', true],
      ['D', 'diode', true],
      ['L1', 'inductor', true],
      ['Cout', 'capacitor', true],
      ['R_LOAD', 'resistor', false],
    ]);
    const result = resultOf(plan);
    expect(result.components.map((c) => c.designator)).toEqual([
      'SW',
      'D',
      'L1',
      'Cout',
    ]);
    expect(result.mtbfHours).toBeGreaterThan(0);
    expect(result.byMethod.map((m) => m.method)).toEqual([
      'MIL-HDBK-217F',
      'Telcordia SR-332',
      'IEC TR 62380',
      'FIDES 2022',
    ]);
    expect(ok(plan).data.settings).toEqual({
      predictionMethod: 'MIL-HDBK-217F',
      environment: 'GB - Ground, Benign (πE=1.0)',
      overrides: {},
    });
  });

  it('uses the device selection, the thermal result and the magnetics design', async () => {
    let project = withCircuit('dcdc_buck');
    project = commitStage(project, 'simulation', {
      deviceSelection: {
        selections: [
          {
            ref: 'SW',
            stress: { vPeakV: 48, iPeakA: 5, iRmsA: 3, fswKhz: 100 },
            selected: { part: 'C3M0065090D', vRatingV: 900 },
          },
        ],
      },
    }).project;
    project = commitStage(project, 'magnetics', {
      designs: [
        {
          ref: 'L1',
          core: 'PQ32/30',
          material: '3C95',
          stacked: 1,
          hotspot_C: 70,
        },
      ],
    }).project;
    project = commitStage(project, 'thermal', {
      result: {
        ambientC: 50,
        devices: [{ ref: 'SW', tjC: 105, status: 'warm' }],
        magnetics: [],
      },
    }).project;
    const parts = partsOf(await planMtbf(project, {}, provider()));
    const sw = parts.find((p) => p.ref === 'SW')!;
    expect(sw).toMatchObject({
      partNumber: 'C3M0065090D',
      voltageV: 48,
      ratedVoltageV: 900,
      temperatureC: 105,
      temperatureSource: 'thermal',
      status: 'warning',
    });
    expect(parts.find((p) => p.ref === 'L1')).toMatchObject({
      partNumber: 'PQ32/30 3C95 (custom wound)',
      temperatureC: 70,
      temperatureSource: 'magnetics',
    });
    expect(parts.find((p) => p.ref === 'Cout')).toMatchObject({
      temperatureC: 50,
      temperatureSource: 'ambient',
    });
  });

  it('gives every phase leg the stress and temperatures of the simulated leg', async () => {
    let project = withCircuit('dcac_neutral_point_clamped');
    project = commitStage(project, 'simulation', {
      deviceSelection: {
        selections: [
          {
            ref: 'SW1',
            stress: { vPeakV: 500, iRmsA: 30 },
            selected: { part: 'C3M0016120K', vRatingV: 1200, iRatingA: 40 },
          },
        ],
      },
    }).project;
    project = commitStage(project, 'magnetics', {
      designs: [
        {
          ref: 'L_FILT',
          core: 'E55/28/21',
          material: '3C97',
          stacked: 3,
          hotspot_C: 80,
        },
      ],
    }).project;
    project = commitStage(project, 'thermal', {
      result: {
        ambientC: 40,
        devices: [{ ref: 'SW1', tjC: 110, status: 'ok' }],
        magnetics: [],
      },
    }).project;
    const plan = await planMtbf(project, {}, provider());
    const parts = partsOf(plan);
    for (const ref of ['SW1_a', 'SW1_b', 'SW1_c']) {
      expect(parts.find((p) => p.ref === ref)).toMatchObject({
        partNumber: 'C3M0016120K',
        voltageV: 500,
        ratedVoltageV: 1200,
        currentA: 30,
        ratedCurrentA: 40,
        temperatureC: 110,
        temperatureSource: 'thermal',
      });
    }
    expect(parts.find((p) => p.ref === 'L_FILT_b')).toMatchObject({
      partNumber: '3× E55/28/21 3C97 (custom wound)',
      temperatureC: 80,
    });
    // 30 A of 40 A raises the stress factor over the placeholder current.
    const result = resultOf(plan) as unknown as {
      components: Array<{ designator: string; lambda: number }>;
    };
    const lambda = (ref: string) =>
      result.components.find((c) => c.designator === ref)!.lambda;
    expect(lambda('SW1_a')).toBeGreaterThan(lambda('SW2_a'));
  });

  it('keeps the method, environment and overrides of the previous run', async () => {
    const first = ok(
      await planMtbf(
        withCircuit('dcdc_buck'),
        {
          predictionMethod: 'Telcordia SR-332',
          environment: 'Uncontrolled (πE=8.0)',
          overrides: { R_LOAD: true, D: false },
        },
        provider(),
      ),
    );
    const project = commitStage(
      withCircuit('dcdc_buck'),
      'mtbf',
      first.data,
    ).project;
    const again = await planMtbf(project, {}, provider());
    expect(ok(again).data.settings).toEqual({
      predictionMethod: 'Telcordia SR-332',
      environment: 'Uncontrolled (πE=8.0)',
      overrides: { R_LOAD: true, D: false },
    });
    expect(
      resultOf(again)
        .components.map((c) => c.designator)
        .sort(),
    ).toEqual(['Cout', 'L1', 'R_LOAD', 'SW']);
  });

  it('a harsher environment lowers the MTBF', async () => {
    const at = async (environment: string) =>
      resultOf(
        await planMtbf(
          withCircuit('dcdc_buck'),
          { predictionMethod: 'MIL-HDBK-217F', environment },
          provider(),
        ),
      ).mtbfHours!;
    expect(
      await at('AUF - Airborne, Uninhabited, Fighter (πE=20.0)'),
    ).toBeLessThan(await at('GB - Ground, Benign (πE=1.0)'));
  });

  it('rejects an environment of another method', async () => {
    const plan = await planMtbf(
      withCircuit('dcdc_buck'),
      { predictionMethod: 'FIDES 2022', environment: 'Controlled (πE=1.0)' },
      provider(),
    );
    expect(plan.ok).toBe(false);
  });

  it('runs standalone from entered parts', async () => {
    const plan = await planMtbf(
      createEmptyProject(),
      {
        parts: [
          {
            ref: 'Q1',
            type: 'mosfet',
            partNumber: 'IPP60R099',
            temperatureC: 90,
          },
          { ref: 'C1', type: 'capacitor' },
        ],
      },
      provider(),
    );
    expect(ok(plan).data.origin).toBe('input');
    expect(partsOf(plan)).toMatchObject([
      {
        ref: 'Q1',
        partNumber: 'IPP60R099',
        temperatureC: 90,
        temperatureSource: 'input',
      },
      { ref: 'C1', temperatureC: 40, temperatureSource: 'assumed' },
    ]);
  });

  it('leaves simulation helpers, line models and body diodes out', async () => {
    const afe = partsOf(
      await planMtbf(
        withCircuit('acdc_single_phase_active_front_end'),
        {},
        provider(),
      ),
    );
    const out = (ref: string) => afe.find((p) => p.ref === ref)?.included;
    expect(out('R_GND_L')).toBe(false);
    expect(out('R_GRID_L')).toBe(false);
    expect(out('R_DC')).toBe(false);
    expect(out('M_A_TOP')).toBe(true);
    expect(out('C_DC')).toBe(true);
    expect(out('R_GA_TOP')).toBe(true); // gate resistor: a real part
  });

  it('leaves the ground anchors of isolated sides out', async () => {
    const flyback = partsOf(
      await planMtbf(withCircuit('dcdc_flyback'), {}, provider()),
    );
    expect(flyback.find((p) => p.ref === 'R_ISO')?.included).toBe(false);
    const dab = partsOf(
      await planMtbf(withCircuit('dcdc_dual_active_bridge'), {}, provider()),
    );
    expect(dab.find((p) => p.ref === 'RR_ISO')?.included).toBe(false);
  });

  it('gives a finite MTBF for every library topology', async () => {
    for (const id of catalog.ids) {
      const result = resultOf(await planMtbf(withCircuit(id), {}, provider()));
      expect([id, Number.isFinite(result.mtbfHours)]).toEqual([id, true]);
    }
  });
});
