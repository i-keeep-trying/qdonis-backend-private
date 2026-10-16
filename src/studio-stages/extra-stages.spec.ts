import {
  commitStage,
  createEmptyProject,
} from '../projects/studio/studio-graph';
import {
  branchParts,
  enteredParts,
  matchEnvironment,
  planBom,
  planComponents,
  planEmc,
  planMtbf,
} from './extra-stages';

const EMC = {
  pfcInductorMH: 1.464,
  htRailVoltage: 394,
  inputPower: 108,
  inputRMSVoltage: 264,
  firstInputCapNF: 1,
  secondInputCapNF: 1,
  inputFilterInductorMH: 8,
};

describe('extra stages', () => {
  it('scans EMC and lists missing inputs', () => {
    const plan = planEmc(EMC, ['passMarginDB']);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.assumedInputs).toEqual(['passMarginDB']);
    expect(typeof plan.result({}).payload?.pass_count).toBe('number');

    const missing = planEmc({ ...EMC, inputPower: undefined });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.result.payload).toEqual({
      missing_inputs: ['input_power_w'],
    });
  });

  it('collects components from the branch', () => {
    let project = createEmptyProject();
    project = commitStage(project, 'design', {
      recalculatedParameters: [
        { ref: 'L1', param: 'value', after: '22u' },
        { ref: 'C1', param: 'value', after: '47u' },
        { ref: 'C1', param: 'esr', after: '0.01' },
      ],
    }).project;
    project = commitStage(project, 'magnetics', {
      designs: [{ ref: 'L1', kind: 'inductor', core: 'E25', material: 'N87' }],
    }).project;
    const parts = branchParts(project);
    expect(parts.map((p) => [p.ref, p.type, p.source])).toEqual([
      ['L1', 'inductor', 'magnetics'],
      ['C1', 'capacitor', 'design'],
    ]);
    expect(planComponents([], 'branch', []).ok).toBe(false);
  });

  it('builds a BOM with the build quantity', () => {
    const parts = enteredParts([
      { ref: 'C1', type: 'capacitor', value: '47 µF', quantity: 2 },
      { ref: 'R1', type: 'resistor', value: '10 kΩ' },
    ]);
    const plan = planBom(parts, 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.summary).toMatchObject({ totalQuantity: 30 });
  });

  it('predicts MTBF with a loosely named environment', () => {
    expect(matchEnvironment('MIL-HDBK-217F', 'ground benign')).toMatch(/^GB/);
    expect(matchEnvironment('MIL-HDBK-217F', 'GF')).toMatch(/^GF/);
    expect(matchEnvironment('MIL-HDBK-217F', 'moon base')).toBeNull();
    const parts = enteredParts([
      { ref: 'C1', type: 'capacitor' },
      { ref: 'Q1', type: 'mosfet' },
    ]);
    const plan = planMtbf(createEmptyProject(), {
      method: 'MIL-HDBK-217F',
      environment: 'ground fixed',
      parts,
      temperatureC: 60,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.mtbfHours).toBeGreaterThan(0);
  });
});
