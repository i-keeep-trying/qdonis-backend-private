import type { BomSourcePart } from '../engines/bom/bom';
import type { MagneticDesign } from '../engines/magnetics/magnetics-engine';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import {
  circuitParts,
  customWound,
  magneticDesigns,
  type PartType,
  refKey,
  selectedDevices,
  type SelectedDevice,
} from './branch-parts';
import type { CircuitDataProvider } from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';

/**
 * BOM stage (port of the old `BOMExportScreen`). The old screen listed the
 * parts picked in Component Selection (Mouser results); here every physical
 * part of the branch circuit is a line, with the Simulation device selection
 * and the custom magnetics filled in, a heatsink line from the Thermal
 * stage's cooling recommendation, and Mouser parts the user picks per line.
 * The user's choices (part, quantity, included, extra lines) are kept on
 * re-runs.
 */

export const BOM_CATEGORIES = [
  'mosfet',
  'diode',
  'inductor',
  'transformer',
  'capacitor',
  'resistor',
  'ic',
  'heatsink',
  'other',
] as const;
export type BomCategory = (typeof BOM_CATEGORIES)[number];

/** A distributor part chosen for a line (from a Mouser search). */
export interface SourcedPart {
  manufacturer: string;
  partNumber: string;
  mouserPartNumber: string | null;
  description: string | null;
  packageType: string | null;
  pricingTiers: Array<{ quantity: number; price: number }>;
  availability: string | null;
  leadTime: string | null;
  rohsStatus: string | null;
  lifecycleStatus: string | null;
  datasheetUrl: string | null;
}

/** The user's choices for one line, kept across re-runs. */
export interface LineChoice {
  included?: boolean;
  quantity?: number;
  part?: SourcedPart;
  /** A line the user added (not in the circuit). */
  extra?: { category: BomCategory; description: string };
}

/** A patch of one line's choice; `null` resets that field (or removes the extra line). */
export interface LineChoicePatch {
  included?: boolean | null;
  quantity?: number | null;
  part?: SourcedPart | null;
  extra?: { category: BomCategory; description: string } | null;
}

export type BomLineSource =
  'mouser' | 'device_selection' | 'magnetics' | 'thermal' | 'none';

export interface BomLine {
  ref: string;
  category: BomCategory;
  role: string | null;
  value: string | null;
  description: string;
  manufacturer: string | null;
  partNumber: string | null;
  mouserPartNumber: string | null;
  packageType: string | null;
  quantity: number;
  /** First price break (single unit), USD; null until a part is sourced. */
  unitPrice: number | null;
  extendedPrice: number | null;
  pricingTiers: Array<{ quantity: number; price: number }>;
  availability: string | null;
  leadTime: string | null;
  rohsStatus: string | null;
  lifecycleStatus: string | null;
  datasheetUrl: string | null;
  source: BomLineSource;
  /** Keyword for a distributor search (part number, or type and value). */
  searchKeyword: string;
  included: boolean;
  excludedReason: string | null;
  /** Added by the user, not in the circuit. */
  extra: boolean;
}

export interface BomTotals {
  lines: number;
  quantity: number;
  /** Sum of the priced lines, USD. */
  cost: number;
  pricedLines: number;
  manufacturers: number;
  inStockLines: number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const fin = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const fail = (
  summary: string,
  payload?: Record<string, unknown>,
): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

const KIND: Record<BomCategory, string> = {
  mosfet: 'Power switch',
  diode: 'Diode',
  inductor: 'Inductor',
  transformer: 'Transformer',
  capacitor: 'Capacitor',
  resistor: 'Resistor',
  ic: 'IC',
  heatsink: 'Heatsink',
  other: 'Part',
};

const SEARCH_WORD: Partial<Record<BomCategory, string>> = {
  capacitor: 'capacitor',
  resistor: 'resistor',
  inductor: 'power inductor',
  transformer: 'transformer',
  diode: 'diode',
  mosfet: 'MOSFET',
};

const inStock = (availability: string | null) =>
  /in stock|available/i.test(availability ?? '');

/** What the branch already knows about a circuit part. */
function known(
  ref: string,
  category: PartType,
  value: string | null,
  devices: Map<string, SelectedDevice>,
  designs: Map<string, MagneticDesign>,
): Pick<
  BomLine,
  'description' | 'manufacturer' | 'partNumber' | 'source' | 'searchKeyword'
> {
  const device = devices.get(refKey(ref));
  if (device && (category === 'mosfet' || category === 'diode')) {
    const rating = [
      device.vRatingV ? `${device.vRatingV} V` : null,
      device.iRatingA ? `${device.iRatingA} A` : null,
    ]
      .filter(Boolean)
      .join(' / ');
    return {
      description: [device.deviceType ?? KIND[category], rating, device.family]
        .filter(Boolean)
        .join(', '),
      manufacturer: device.manufacturer,
      partNumber: device.part,
      source: 'device_selection',
      searchKeyword: device.part,
    };
  }
  const design = designs.get(refKey(ref));
  if (design && (category === 'inductor' || category === 'transformer')) {
    const turns = design.turnsSecondary
      ? `${design.turnsPrimary}:${design.turnsSecondary} turns`
      : `${design.turnsPrimary} turns`;
    return {
      description: [KIND[category], value, `${turns}, ${design.wirePrimary}`]
        .filter(Boolean)
        .join(', '),
      manufacturer: 'Custom',
      partNumber: customWound(design),
      source: 'magnetics',
      // The bobbin-less core set is what is bought.
      searchKeyword: `${design.core} ${design.material}`,
    };
  }
  return {
    description: [KIND[category], value].filter(Boolean).join(' '),
    manufacturer: null,
    partNumber: null,
    source: 'none',
    searchKeyword: [value?.replace(/\s+/g, ''), SEARCH_WORD[category]]
      .filter(Boolean)
      .join(' '),
  };
}

/** Heatsink spec from the Thermal stage's cooling recommendation, if any. */
function heatsinkLine(
  project: StudioProject,
): Pick<BomLine, 'description' | 'source' | 'searchKeyword'> | null {
  const result = rec(rec(stageNodeOnBranch(project, 'thermal')?.data).result);
  const cooling = rec(result.cooling);
  const sink = rec(cooling.heatsink);
  const rsa = fin(sink.rsaMaxCW) ?? fin(rec(result.heatsink).rsaRequired);
  if (rsa === undefined) return null;
  const method = str(cooling.method);
  const size = str(sink.sizeHint);
  return {
    description: [
      `Heatsink, Rθsa ≤ ${Number(rsa.toPrecision(3))} °C/W`,
      method,
      size,
    ]
      .filter(Boolean)
      .join(', '),
    source: 'thermal',
    searchKeyword: 'heatsink TO-247',
  };
}

/** Applies a sourced part (it replaces what the branch knew). */
function withPart(line: BomLine, part: SourcedPart | undefined): BomLine {
  if (!part) return line;
  return {
    ...line,
    manufacturer: part.manufacturer,
    partNumber: part.partNumber,
    mouserPartNumber: part.mouserPartNumber,
    description: part.description || line.description,
    packageType: part.packageType,
    pricingTiers: part.pricingTiers,
    availability: part.availability,
    leadTime: part.leadTime,
    rohsStatus: part.rohsStatus,
    lifecycleStatus: part.lifecycleStatus,
    datasheetUrl: part.datasheetUrl,
    source: 'mouser',
  };
}

function priced(line: BomLine): BomLine {
  // First price break = single-unit price (old behaviour).
  const tier = line.pricingTiers[0]?.price;
  const unitPrice =
    typeof tier === 'number' && Number.isFinite(tier) && tier >= 0
      ? tier
      : null;
  return {
    ...line,
    unitPrice,
    extendedPrice: unitPrice === null ? null : unitPrice * line.quantity,
  };
}

export function bomTotals(lines: BomLine[]): BomTotals {
  const counted = lines.filter((l) => l.included);
  return {
    lines: counted.length,
    quantity: counted.reduce((s, l) => s + l.quantity, 0),
    cost: counted.reduce((s, l) => s + (l.extendedPrice ?? 0), 0),
    pricedLines: counted.filter((l) => l.unitPrice !== null).length,
    manufacturers: new Set(
      counted.map((l) => l.manufacturer).filter((m): m is string => !!m),
    ).size,
    inStockLines: counted.filter((l) => inStock(l.availability)).length,
  };
}

/** Included lines in the export engine's shape (`engines/bom`). */
export function exportParts(lines: BomLine[]): BomSourcePart[] {
  return lines
    .filter((l) => l.included)
    .map((l) => ({
      componentName: l.ref,
      manufacturer: l.manufacturer ?? undefined,
      partNumber: l.partNumber ?? undefined,
      mouserPartNumber: l.mouserPartNumber ?? undefined,
      description: l.description,
      quantity: l.quantity,
      mountingType: l.packageType ?? undefined,
      pricingTiers: l.pricingTiers,
      availability: l.availability ?? undefined,
      leadTime: l.leadTime ?? undefined,
      rohsStatus: l.rohsStatus ?? undefined,
      lifecycleStatus: l.lifecycleStatus ?? undefined,
      datasheetLink: l.datasheetUrl ?? undefined,
    }));
}

/** Stored choices merged with a patch (`null` fields reset). */
export function mergeChoices(
  stored: Record<string, LineChoice>,
  patch: Record<string, LineChoicePatch>,
): Record<string, LineChoice> {
  const out: Record<string, LineChoice> = { ...stored };
  for (const [ref, change] of Object.entries(patch)) {
    const next: LineChoice = { ...out[ref] };
    for (const field of ['included', 'quantity', 'part', 'extra'] as const) {
      if (!(field in change)) continue;
      const value = change[field];
      if (value === null || value === undefined) delete next[field];
      else (next as Record<string, unknown>)[field] = value;
    }
    if (Object.keys(next).length) out[ref] = next;
    else delete out[ref];
  }
  return out;
}

export async function planBom(
  project: StudioProject,
  patch: Record<string, LineChoicePatch>,
  provider: CircuitDataProvider,
): Promise<StagePlan> {
  const previous = rec(stageNodeOnBranch(project, 'bom')?.data);
  const choices = mergeChoices(
    rec(previous.choices) as Record<string, LineChoice>,
    patch,
  );
  const circuit = await circuitParts(project, provider);
  if (!circuit) {
    return fail(
      'The BOM lists the parts of the branch circuit, and this branch has none yet: choose a topology (select_topology) or import a netlist first.',
      { missing: 'circuit' },
    );
  }
  const devices = selectedDevices(project);
  const designs = magneticDesigns(project);
  const base = (
    ref: string,
    category: BomCategory,
    fields: Partial<BomLine>,
  ): BomLine => ({
    ref,
    category,
    role: null,
    value: null,
    description: KIND[category],
    manufacturer: null,
    partNumber: null,
    mouserPartNumber: null,
    packageType: null,
    quantity: 1,
    unitPrice: null,
    extendedPrice: null,
    pricingTiers: [],
    availability: null,
    leadTime: null,
    rohsStatus: null,
    lifecycleStatus: null,
    datasheetUrl: null,
    source: 'none',
    searchKeyword: KIND[category],
    included: true,
    excludedReason: null,
    extra: false,
    ...fields,
  });

  const lines: BomLine[] = circuit.parts.map((p) =>
    base(p.ref, p.type, {
      role: p.role,
      value: p.value,
      ...known(p.ref, p.type, p.value, devices, designs),
      included: p.excludedReason === null,
      excludedReason: p.excludedReason,
    }),
  );
  const sink = heatsinkLine(project);
  const refs = new Set(lines.map((l) => refKey(l.ref)));
  if (sink && !refs.has('hs1')) {
    lines.push(base('HS1', 'heatsink', sink));
    refs.add('hs1');
  }
  for (const [ref, choice] of Object.entries(choices)) {
    if (choice.extra && !refs.has(refKey(ref))) {
      lines.push(
        base(ref, choice.extra.category, {
          description: choice.extra.description,
          searchKeyword: choice.extra.description,
          extra: true,
        }),
      );
      refs.add(refKey(ref));
    }
  }
  // Choices of lines that are gone (circuit edited) are dropped.
  for (const ref of Object.keys(choices)) {
    if (!refs.has(refKey(ref))) delete choices[ref];
  }

  const final = lines.map((line) => {
    const choice = choices[line.ref] ?? {};
    return priced(
      withPart(
        {
          ...line,
          included: choice.included ?? line.included,
          quantity: choice.quantity ?? line.quantity,
        },
        choice.part,
      ),
    );
  });
  const totals = bomTotals(final);
  if (totals.lines === 0) {
    return fail('Every line is excluded: include at least one part.', {
      missing: 'lines',
    });
  }

  const data = JSON.parse(
    JSON.stringify({ lines: final, totals, choices, currency: 'USD' }),
  ) as Record<string, unknown>;
  const counted = final.filter((l) => l.included);
  const unsourced = counted.filter((l) => l.unitPrice === null);
  const cost = `$${totals.cost.toFixed(2)}`;
  return {
    ok: true,
    data,
    summary: `BOM · ${totals.lines} lines · ${totals.quantity} parts${totals.pricedLines ? ` · ${cost}` : ''}`,
    result: (fork) => ({
      ok: true,
      summary: `BOM · ${totals.lines} lines, ${totals.quantity} parts, ${totals.pricedLines}/${totals.lines} priced${totals.pricedLines ? ` (${cost})` : ''}`,
      payload: {
        lines: counted.map((l) => ({
          ref: l.ref,
          part: l.partNumber ?? l.description,
          manufacturer: l.manufacturer ?? undefined,
          quantity: l.quantity,
          unit_price_usd: l.unitPrice ?? undefined,
          from: l.source,
        })),
        excluded: final
          .filter((l) => !l.included)
          .map((l) => ({
            ref: l.ref,
            reason: l.excludedReason ?? 'excluded by the user',
          })),
        totals: {
          lines: totals.lines,
          quantity: totals.quantity,
          priced_lines: totals.pricedLines,
          cost_usd: Number(totals.cost.toFixed(2)),
          manufacturers: totals.manufacturers,
          in_stock_lines: totals.inStockLines,
        },
        ...(unsourced.length
          ? {
              note: `${unsourced.length} line(s) have no distributor part yet (${unsourced
                .slice(0, 12)
                .map((l) => l.ref)
                .join(
                  ', ',
                )}). The user picks Mouser parts per line in the BOM view (Find on Mouser), which also exports XLSX / CSV.`,
            }
          : {}),
        ...fork,
      },
    }),
  };
}
