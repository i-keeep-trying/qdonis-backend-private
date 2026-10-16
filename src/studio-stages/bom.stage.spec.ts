import { circuitInventory } from '../circuits/library/circuit-inventory';
import { ASSETS_ROOT } from '../common/assets/assets-root';
import { bomCsv, bomRows } from '../engines/bom/bom';
import {
  commitStage,
  createEmptyProject,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { loadTopologyCatalog } from '../topologies/library/topology-catalog.loader';
import type { TopologyCatalog } from '../topologies/topologies.types';
import {
  type BomLine,
  exportParts,
  mergeChoices,
  planBom,
  type SourcedPart,
} from './bom.stage';
import type {
  CircuitDataProvider,
  CircuitInventory,
} from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';

let catalog: TopologyCatalog;
beforeAll(async () => {
  catalog = await loadTopologyCatalog(ASSETS_ROOT);
});

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
const linesOf = (plan: StagePlan) => ok(plan).data.lines as BomLine[];
const line = (plan: StagePlan, ref: string) =>
  linesOf(plan).find((l) => l.ref === ref)!;

const MOUSER: SourcedPart = {
  manufacturer: 'TDK',
  partNumber: 'C5750X7R1H476M',
  mouserPartNumber: '810-C5750X7R1H476M',
  description: 'Multilayer Ceramic Capacitors 47uF 50V X7R',
  packageType: '2220',
  pricingTiers: [
    { quantity: 1, price: 2.5 },
    { quantity: 10, price: 2.1 },
  ],
  availability: '1,234 In Stock',
  leadTime: '12 Weeks',
  rohsStatus: 'RoHS Compliant',
  lifecycleStatus: 'Active',
  datasheetUrl: 'https://example.com/ds.pdf',
};

describe('BOM stage', () => {
  it('needs a circuit', async () => {
    const plan = await planBom(createEmptyProject(), {}, provider());
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.result.payload?.missing).toBe('circuit');
  });

  it('lists the circuit parts and leaves the load out', async () => {
    const plan = await planBom(withCircuit('dcdc_buck'), {}, provider());
    expect(
      linesOf(plan).map((l) => [l.ref, l.category, l.included, l.quantity]),
    ).toEqual([
      ['SW', 'mosfet', true, 1],
      ['D', 'diode', true, 1],
      ['L1', 'inductor', true, 1],
      ['Cout', 'capacitor', true, 1],
      ['R_LOAD', 'resistor', false, 1],
    ]);
    expect(ok(plan).data.totals).toMatchObject({
      lines: 4,
      quantity: 4,
      cost: 0,
      pricedLines: 0,
    });
    expect(line(plan, 'Cout').searchKeyword).toMatch(/capacitor$/);
  });

  it('fills the selected devices, custom magnetics and the heatsink', async () => {
    let project = withCircuit('dcdc_buck');
    project = commitStage(project, 'simulation', {
      deviceSelection: {
        selections: [
          {
            ref: 'SW',
            stress: { vPeakV: 48 },
            selected: {
              part: 'C3M0065090D',
              manufacturer: 'Wolfspeed',
              type: 'MOSFET',
              family: 'SiC Gen 3',
              vRatingV: 900,
              iRatingA: 36,
            },
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
          turnsPrimary: 14,
          wirePrimary: '3×0.5 mm',
        },
      ],
    }).project;
    project = commitStage(project, 'thermal', {
      result: {
        devices: [],
        cooling: {
          method: 'Natural convection',
          heatsink: { rsaMaxCW: 4.25, sizeHint: '~60 cm³ extruded' },
        },
      },
    }).project;
    const plan = await planBom(project, {}, provider());
    expect(line(plan, 'SW')).toMatchObject({
      manufacturer: 'Wolfspeed',
      partNumber: 'C3M0065090D',
      description: 'MOSFET, 900 V / 36 A, SiC Gen 3',
      source: 'device_selection',
    });
    expect(line(plan, 'L1')).toMatchObject({
      manufacturer: 'Custom',
      partNumber: 'PQ32/30 3C95 (custom wound)',
      source: 'magnetics',
      searchKeyword: 'PQ32/30 3C95',
    });
    expect(line(plan, 'HS1')).toMatchObject({
      category: 'heatsink',
      description:
        'Heatsink, Rθsa ≤ 4.25 °C/W, Natural convection, ~60 cm³ extruded',
      source: 'thermal',
    });
  });

  it('keeps the user choices across re-runs and prices sourced lines', async () => {
    const first = ok(
      await planBom(
        withCircuit('dcdc_buck'),
        {
          Cout: { part: MOUSER, quantity: 3 },
          U1: {
            extra: { category: 'ic', description: 'PWM controller' },
          },
          D: { included: false },
        },
        provider(),
      ),
    );
    const project = commitStage(
      withCircuit('dcdc_buck'),
      'bom',
      first.data,
    ).project;
    const again = await planBom(project, {}, provider());
    expect(line(again, 'Cout')).toMatchObject({
      manufacturer: 'TDK',
      quantity: 3,
      unitPrice: 2.5,
      extendedPrice: 7.5,
      source: 'mouser',
    });
    expect(line(again, 'U1')).toMatchObject({
      category: 'ic',
      description: 'PWM controller',
      extra: true,
      included: true,
    });
    expect(line(again, 'D').included).toBe(false);
    expect(ok(again).data.totals).toMatchObject({
      lines: 4,
      quantity: 6,
      cost: 7.5,
      pricedLines: 1,
      inStockLines: 1,
    });

    // Removing the added line and resetting the part.
    const reset = await planBom(
      project,
      { U1: { extra: null }, Cout: { part: null } },
      provider(),
    );
    expect(linesOf(reset).some((l) => l.ref === 'U1')).toBe(false);
    expect(line(reset, 'Cout')).toMatchObject({
      unitPrice: null,
      quantity: 3,
      source: 'none',
    });
  });

  it('merges choice patches field by field', () => {
    expect(
      mergeChoices(
        { Q1: { quantity: 2, included: false } },
        { Q1: { included: null }, C1: { quantity: 4 }, X: { part: null } },
      ),
    ).toEqual({ Q1: { quantity: 2 }, C1: { quantity: 4 } });
  });

  it('exports the included lines in the old BOM format', async () => {
    const plan = await planBom(
      withCircuit('dcdc_buck'),
      { Cout: { part: MOUSER, quantity: 2 } },
      provider(),
    );
    const rows = bomRows(exportParts(linesOf(plan)));
    expect(rows.map((r) => r.designator)).toEqual(['SW', 'D', 'L1', 'Cout']);
    expect(rows[3]).toMatchObject({
      manufacturerPartNumber: 'C5750X7R1H476M',
      mouserPartNumber: '810-C5750X7R1H476M',
      quantity: 2,
      extendedPrice: 5,
    });
    expect(bomCsv(rows).toString('utf8')).toContain('"810-C5750X7R1H476M"');
  });

  it('builds a BOM for every library topology', async () => {
    for (const id of catalog.ids) {
      const plan = await planBom(withCircuit(id), {}, provider());
      expect([id, plan.ok]).toEqual([id, true]);
    }
  });
});
