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
  type PartLookup,
  partKey,
  partsToLookUp,
  planBom,
  type SourcedPart,
  unitPriceAt,
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
  currency: 'GBP',
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
      description: 'SiC Gen 3, 900 V / 36 A',
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
      currency: 'GBP',
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
    const csv = bomCsv(rows, 'GBP').toString('utf8');
    expect(csv).toContain('"810-C5750X7R1H476M"');
    expect(csv).toContain('Unit Price (£)');
    // Unpriced lines leave the price cells empty.
    expect(csv.split('\n')[1]).toContain(',,');
  });

  it('matches every phase leg to the simulated leg and groups same parts', async () => {
    let project = withCircuit('dcac_neutral_point_clamped');
    project = commitStage(project, 'simulation', {
      deviceSelection: {
        selections: ['SW1', 'SW2', 'SW3', 'SW4'].map((ref) => ({
          ref,
          stress: { vPeakV: 500, iRmsA: 21 },
          selected: {
            part: 'C3M0065090D',
            manufacturer: 'Wolfspeed',
            type: 'MOSFET',
            family: 'SiC MOSFET',
            vRatingV: 900,
            iRatingA: 36,
          },
        })),
      },
    }).project;
    const plan = await planBom(project, {}, provider());
    const switches = linesOf(plan).find((l) => l.partNumber === 'C3M0065090D')!;
    expect(switches.refs).toHaveLength(12);
    expect(switches.refs.slice(0, 4)).toEqual([
      'SW1_a',
      'SW2_a',
      'SW3_a',
      'SW4_a',
    ]);
    expect(switches).toMatchObject({
      ref: 'SW1_a',
      quantity: 12,
      included: true,
    });
    // Same-valued filter capacitors of the three phases are one line.
    const caps = linesOf(plan).find((l) => l.ref === 'C_FILT_a')!;
    expect(caps.refs).toEqual(['C_FILT_a', 'C_FILT_b', 'C_FILT_c']);
    // A designator changed on its own leaves the group.
    const split = await planBom(
      project,
      { SW1_c: { included: false } },
      provider(),
    );
    expect(
      linesOf(split).find((l) => l.partNumber === 'C3M0065090D' && l.included)!
        .quantity,
    ).toBe(11);
  });

  it('prices the selected devices from the Mouser lookups', async () => {
    let project = withCircuit('dcdc_buck');
    project = commitStage(project, 'simulation', {
      deviceSelection: {
        selections: [
          {
            ref: 'SW',
            selected: {
              part: 'C5750X7R1H476M',
              manufacturer: 'TDK',
              type: 'MOSFET',
            },
          },
          {
            ref: 'D',
            selected: {
              part: 'DIM600DDM12-A000',
              manufacturer: 'Dynex',
              type: 'Diode',
            },
          },
        ],
      },
    }).project;
    const first = ok(
      await planBom(project, { SW: { quantity: 12 } }, provider()),
    );
    expect(
      partsToLookUp(first.data.lines as BomLine[], {}, false).sort(),
    ).toEqual(['C5750X7R1H476M', 'DIM600DDM12-A000']);

    const checkedAt = '2026-10-16T12:00:00.000Z';
    const plan = ok(
      await planBom(project, { SW: { quantity: 12 } }, provider(), {
        [partKey('C5750X7R1H476M')]: { part: MOUSER, checkedAt },
        [partKey('DIM600DDM12-A000')]: { part: null, checkedAt },
      }),
    );
    // 12 reaches the 10-piece break.
    expect(line(plan, 'SW')).toMatchObject({
      source: 'mouser',
      autoMatched: true,
      unitPrice: 2.1,
      extendedPrice: 25.2,
      currency: 'GBP',
    });
    expect(line(plan, 'D')).toMatchObject({
      source: 'device_selection',
      unitPrice: null,
    });
    expect(line(plan, 'D').note).toMatch(/not listed on Mouser/);
    expect(plan.data.totals).toMatchObject({ cost: 25.2, currency: 'GBP' });

    // Stored lookups are reused; the missing part is retried on a rebuild only.
    const stored = commitStage(project, 'bom', plan.data).project;
    const again = ok(await planBom(stored, {}, provider()));
    expect(line(again, 'SW').autoMatched).toBe(true);
    const lookups = again.data.lookups as Record<string, PartLookup>;
    expect(
      partsToLookUp(again.data.lines as BomLine[], lookups, false),
    ).toEqual([]);
    expect(partsToLookUp(again.data.lines as BomLine[], lookups, true)).toEqual(
      ['DIM600DDM12-A000'],
    );
  });

  it('prices at the quantity break and flags a minimum order', () => {
    const tiers = [
      { quantity: 1, price: 0 },
      { quantity: 5, price: 3 },
      { quantity: 50, price: 2 },
    ];
    expect(unitPriceAt(tiers, 2)).toEqual({ price: 3, minimum: 5 });
    expect(unitPriceAt(tiers, 60)).toEqual({ price: 2, minimum: 5 });
    expect(unitPriceAt([{ quantity: 1, price: 0 }], 1)).toBeNull();
  });

  it('builds a BOM for every library topology', async () => {
    for (const id of catalog.ids) {
      const plan = await planBom(withCircuit(id), {}, provider());
      expect([id, plan.ok]).toEqual([id, true]);
    }
  });
});
